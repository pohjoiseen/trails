#!/usr/bin/env python3
"""Build the app's data files from the curated source in data-src/.

Inputs
  data-src/trails.json        curated trail list (metadata, parking, geometry recipe, rating, photos)
  data-src/text/<lang>.json   per-language texts {id: {desc, highlights, network_note, access, season, parking_notes, duration}}
  data-src/geometry/          cache of raw geometries (lipas-<id>.json, osm-*.json, manual <id>.geojson)

Outputs
  data/trails.json            index with simplified overview lines
  data/tracks/<id>.json       full-detail lines, loaded when a trail is opened
  data/text/<lang>.json       copied texts

Geometry recipe per trail (trail["geometry"]):
  {"lipas_ids": [..], "lipas_parts": {"<id>": [indices]} (optional subset), "osm": ["way/1", "relation/2"],
   "file": "data-src/geometry/manual/<id>.geojson", "waypoints": [[lat,lon],...], "quality": "exact|approx|partial"}
"""
import json, math, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data-src")
OUT = os.path.join(ROOT, "data")
CACHE = os.path.join(SRC, "geometry")


def fetch(url, data=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "vaasa-trails-build/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa
            print("  retry", url[:80], e, file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise RuntimeError("fetch failed " + url)


def lipas_lines(lid):
    path = os.path.join(CACHE, "lipas-%s.json" % lid)
    if not os.path.exists(path):
        raw = fetch("https://api.lipas.fi/v2/sports-sites/%s" % lid)
        with open(path, "wb") as f:
            f.write(raw)
    d = json.load(open(path))
    feats = d["location"]["geometries"]["features"]
    out = []
    for f in feats:
        g = f["geometry"]
        if g["type"] == "LineString":
            out.append([[c[1], c[0]] for c in g["coordinates"]])
        elif g["type"] == "MultiLineString":
            out += [[[c[1], c[0]] for c in ln] for ln in g["coordinates"]]
    return out


def osm_lines(ref):
    """Ways of an OSM way or relation (direct members only), via the OSM API; cached."""
    typ, oid = ref.split("/")
    path = os.path.join(CACHE, "osm-%s-%s.json" % (typ, oid))
    if not os.path.exists(path):
        raw = fetch("https://api.openstreetmap.org/api/0.6/%s/%s/full.json" % (typ, oid))
        with open(path, "wb") as f:
            f.write(raw)
    d = json.load(open(path))
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in d["elements"] if e["type"] == "node"}
    ways = {e["id"]: e for e in d["elements"] if e["type"] == "way"}
    if typ == "relation":
        rel = [e for e in d["elements"] if e["type"] == "relation" and e["id"] == int(oid)][0]
        order = [m["ref"] for m in rel["members"] if m["type"] == "way" and m["ref"] in ways]
    else:
        order = list(ways)
    return [[list(nodes[n]) for n in ways[w]["nodes"] if n in nodes] for w in order]


def gpx_lines(path):
    import xml.etree.ElementTree as ET
    root = ET.parse(os.path.join(ROOT, path)).getroot()
    out = []
    for seg in root.iter():
        if seg.tag.endswith("trkseg") or seg.tag.endswith("}rte") or seg.tag == "rte":
            pts = [[float(p.get("lat")), float(p.get("lon"))] for p in seg if p.tag.endswith("trkpt") or p.tag.endswith("rtept")]
            if len(pts) > 1:
                out.append(pts)
    return out


def file_lines(path):
    d = json.load(open(os.path.join(ROOT, path)))
    if isinstance(d, list):  # bare [[[lon,lat],...],...] multiline
        return [[[c[1], c[0]] for c in ln] for ln in d]
    feats = d["features"] if d.get("type") == "FeatureCollection" else [d]
    out = []
    for f in feats:
        g = f.get("geometry", f)
        if g["type"] == "LineString":
            out.append([[c[1], c[0]] for c in g["coordinates"]])
        elif g["type"] == "MultiLineString":
            out += [[[c[1], c[0]] for c in ln] for ln in g["coordinates"]]
    return out


# ---------- geometry helpers ----------
def dist_m(a, b):
    dx = (b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2)) * 111320
    dy = (b[0] - a[0]) * 110570
    return math.hypot(dx, dy)


def length_km(lines):
    return sum(dist_m(a, b) for ln in lines for a, b in zip(ln, ln[1:])) / 1000


def merge_chains(lines, tol=8.0):
    """Join segments whose endpoints touch (within tol metres) into longer polylines."""
    lines = [ln[:] for ln in lines if len(ln) >= 2]
    changed = True
    while changed:
        changed = False
        for i in range(len(lines)):
            if changed:
                break
            for j in range(len(lines)):
                if i == j:
                    continue
                a, b = lines[i], lines[j]
                if dist_m(a[-1], b[0]) <= tol:
                    lines[i] = a + b[1:]
                elif dist_m(a[-1], b[-1]) <= tol:
                    lines[i] = a + b[::-1][1:]
                elif dist_m(a[0], b[-1]) <= tol:
                    lines[i] = b + a[1:]
                elif dist_m(a[0], b[0]) <= tol:
                    lines[i] = b[::-1] + a[1:]
                else:
                    continue
                del lines[j]
                changed = True
                break
    return lines


def dedupe(lines, tol=12.0, step=4.0, min_run=25.0):
    """Remove stretches that retrace already-drawn path (out-and-back sections, overlapping
    segments from several sources, near-parallel duplicates within `tol` metres).
    Lines are processed longest first; each kept run is joined to the path that covers its ends."""
    if not lines:
        return lines
    lat0 = sum(p[0] for ln in lines for p in ln) / sum(len(ln) for ln in lines)
    kx, ky = math.cos(math.radians(lat0)) * 111320, 110570
    to_xy = lambda p: (p[1] * kx, p[0] * ky)
    to_ll = lambda x, y: [y / ky, x / kx]

    def densify(ln):
        out = [to_xy(ln[0])]
        for a, b in zip(ln, ln[1:]):
            (x0, y0), (x1, y1) = to_xy(a), to_xy(b)
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) // step))
            out += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(1, n + 1)]
        return out
    dense = sorted((densify(ln) for ln in lines if len(ln) > 1), key=lambda d: -len(d))
    grid = {}
    cell = lambda x, y: (int(x // tol), int(y // tol))
    out = []
    for li, pts in enumerate(dense):
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        cover = []
        for i, (x, y) in enumerate(pts):
            cx, cy = cell(x, y)
            best = None
            for gx in (cx - 1, cx, cx + 1):
                for gy in (cy - 1, cy, cy + 1):
                    for (qx, qy, ql, qs) in grid.get((gx, gy), ()):
                        if ql == li and abs(qs - cum[i]) <= 3 * tol:
                            continue
                        d = math.hypot(qx - x, qy - y)
                        if d <= tol and (best is None or d < best[0]):
                            best = (d, qx, qy)
            cover.append(best)
            grid.setdefault((cx, cy), []).append((x, y, li, cum[i]))
        i, n = 0, len(pts)
        while i < n:
            if cover[i] is not None:
                i += 1
                continue
            j = i
            while j < n and cover[j] is None:
                j += 1
            run = pts[i:j]
            if i > 0:
                run = [(cover[i - 1][1], cover[i - 1][2])] + run
            if j < n:
                run = run + [(cover[j][1], cover[j][2])]
            runlen = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(run, run[1:]))
            if runlen >= min_run or (i == 0 and j == n):
                out.append([to_ll(x, y) for x, y in run])
            i = j
    return out


def snap_ends(lines, tol=30.0):
    """Close small gaps: extend each free line end to the nearest point on another line within `tol` m."""
    if len(lines) < 2:
        return lines
    lat0 = lines[0][0][0]
    kx, ky = math.cos(math.radians(lat0)) * 111320, 110570
    XY = [[(p[1] * kx, p[0] * ky) for p in ln] for ln in lines]

    def nearest(px, py, skip):
        best = None
        for j, ln in enumerate(XY):
            if j == skip:
                continue
            for (ax, ay), (bx, by) in zip(ln, ln[1:]):
                dx, dy = bx - ax, by - ay
                L2 = dx * dx + dy * dy
                tt = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
                qx, qy = ax + tt * dx, ay + tt * dy
                d = math.hypot(qx - px, qy - py)
                if best is None or d < best[0]:
                    best = (d, qx, qy)
        return best
    out = [ln[:] for ln in lines]
    for i, ln in enumerate(XY):
        for end in (0, -1):
            b = nearest(*ln[end], i)
            if b and 0.5 < b[0] <= tol:
                pt = [b[2] / ky, b[1] / kx]
                if end == 0:
                    out[i].insert(0, pt)
                else:
                    out[i].append(pt)
    return out


def dp(points, eps):
    """Douglas-Peucker in local metres."""
    if len(points) < 3:
        return points
    lat0 = points[0][0]
    kx = math.cos(math.radians(lat0)) * 111320
    ky = 110570
    P = [(p[1] * kx, p[0] * ky) for p in points]
    keep = [False] * len(P)
    keep[0] = keep[-1] = True
    stack = [(0, len(P) - 1)]
    while stack:
        s, e = stack.pop()
        ax, ay = P[s]
        bx, by = P[e]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, idx = 0, -1
        for k in range(s + 1, e):
            px, py = P[k]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                tt = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - (ax + tt * dx), py - (ay + tt * dy))
            if d > best:
                best, idx = d, k
        if best > eps and idx > 0:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(points, keep) if k]


def rnd(lines, nd=5):
    return [[[round(p[0], nd), round(p[1], nd)] for p in ln] for ln in lines]


def main():
    trails = json.load(open(os.path.join(SRC, "trails.json")))
    os.makedirs(os.path.join(OUT, "tracks"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "text"), exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)
    index = []
    seen = set()
    for tr in trails:
        if tr.get("hidden"):
            continue
        tid = tr["id"]
        assert tid not in seen, tid
        seen.add(tid)
        g = tr.get("geometry", {})
        lines = []
        for lid in g.get("lipas_ids", []):
            ls = lipas_lines(lid)
            parts = (g.get("lipas_parts") or {}).get(str(lid))
            if parts is not None:
                ls = [ls[i] for i in parts]
            lines += ls
        for ref in g.get("osm", []):
            lines += osm_lines(ref)
        for fp in ([g["file"]] if isinstance(g.get("file"), str) else g.get("file", [])):
            lines += gpx_lines(fp) if fp.lower().endswith(".gpx") else file_lines(fp)
        if g.get("waypoints"):
            wp = g["waypoints"]
            lines += wp if wp and isinstance(wp[0][0], list) else [wp]
        lines = merge_chains(lines)
        if not g.get("keep_duplicates"):
            lines = merge_chains(dedupe(lines), tol=1.0)
        lines = snap_ends(lines)
        lines = [ln for ln in lines if len(ln) >= 2]
        detail = [dp(ln, 1.5) for ln in lines]
        overview = [dp(ln, 12) for ln in lines]
        geom_km = round(length_km(detail), 2)
        pts = [p for ln in detail for p in ln] + [[p["lat"], p["lon"]] for p in tr.get("parking", [])]
        if pts:
            s = min(p[0] for p in pts); n = max(p[0] for p in pts)
            w = min(p[1] for p in pts); e = max(p[1] for p in pts)
            bbox = [[round(s, 5), round(w, 5)], [round(n, 5), round(e, 5)]]
            center = [round((s + n) / 2, 5), round((w + e) / 2, 5)]
        else:
            bbox = center = None
        with open(os.path.join(OUT, "tracks", tid + ".json"), "w") as f:
            json.dump({"id": tid, "lines": rnd(detail), "km": geom_km}, f, separators=(",", ":"))
        item = {
            "id": tid,
            "municipality": tr["municipality"],
            "area": tr.get("area"),
            "name": tr["name"],
            "aka": tr.get("aka", []),
            "local": tr.get("local", "fi"),
            "kind": tr["kind"],
            "length_km": tr["length_km"],
            "rating": tr.get("rating"),
            "parking": tr.get("parking", []),
            "facilities": tr.get("facilities", []),
            "photos": tr.get("photos", []),
            "sources": tr.get("sources", []),
            "geom_quality": g.get("quality", "exact"),
            "geom_km": geom_km,
            "borderline": tr.get("borderline", False),
            "bbox": bbox,
            "center": center,
            "line": rnd(overview),
        }
        # Length label: on the track, at the vertex nearest the track's centre, so labels of trails
        # sharing a car park don't stack on the parking marker.
        if tr.get("pin"):
            item["pin"] = tr["pin"]
        elif detail:
            tp = [p for ln in detail for p in ln]
            cy = sum(p[0] for p in tp) / len(tp); cx = sum(p[1] for p in tp) / len(tp)
            best = min(tp, key=lambda p: dist_m(p, [cy, cx]))
            item["pin"] = [round(best[0], 5), round(best[1], 5)]
        index.append(item)
        print("%-34s %6.2f km geom  %s km stated  parts=%d" % (tid, geom_km, tr["length_km"], len(detail)))
    with open(os.path.join(OUT, "trails.json"), "w") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d"), "trails": index}, f, ensure_ascii=False, separators=(",", ":"))
    for lang in ("en", "fi", "sv", "ru"):
        p = os.path.join(SRC, "text", lang + ".json")
        if os.path.exists(p):
            d = json.load(open(p))
            d = {k: v for k, v in d.items() if k in seen}
            with open(os.path.join(OUT, "text", lang + ".json"), "w") as f:
                json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    for fn in os.listdir(os.path.join(OUT, "tracks")):
        if fn[:-5] not in seen:
            os.remove(os.path.join(OUT, "tracks", fn))
    print("trails:", len(index))


if __name__ == "__main__":
    main()
