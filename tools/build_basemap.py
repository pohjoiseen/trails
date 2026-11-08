#!/usr/bin/env python3
"""Build the simplified vector basemap (data/basemap/*.json) from Overpass cell dumps.

The Claude artifact sandbox blocks external images, so OSM raster tiles cannot load there.
This produces a light self-hosted map: land, lakes, rivers, main roads, place names.
Data © OpenStreetMap contributors (ODbL).

Usage: build_basemap.py <dir-with-overpass-json-cells>
Needs: shapely
"""
import glob, json, os, sys
from shapely.geometry import LineString, Polygon, Point, box, mapping, shape
from shapely.ops import linemerge, polygonize, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "basemap")
BBOX = (20.95, 62.75, 22.95, 63.45)  # lon/lat
SEA_POINTS = [(21.0, 62.8), (21.0, 63.4), (21.2, 63.1), (21.05, 63.0)]
ROAD_CLASS = {"motorway": 1, "trunk": 1, "motorway_link": 1, "trunk_link": 1, "primary": 2, "primary_link": 2,
              "secondary": 3, "tertiary": 4, "unclassified": 5}
PLACE_RANK = {"city": 1, "town": 1, "suburb": 2, "village": 2, "hamlet": 3, "island": 3, "neighbourhood": 4, "islet": 4}


def rnd_geom(g, nd=4):
    m = mapping(g)

    def r(c):
        if isinstance(c[0], (float, int)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def main(cells_dir):
    ways, rels, nodes = {}, {}, {}
    for f in glob.glob(os.path.join(cells_dir, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            print("skip", f)
            continue
        for e in d["elements"]:
            if e["type"] == "way":
                ways[e["id"]] = e
            elif e["type"] == "relation":
                rels[e["id"]] = e
            elif e["type"] == "node":
                nodes[e["id"]] = e
    print("ways", len(ways), "rels", len(rels), "nodes", len(nodes))
    clip = box(*BBOX)

    # ---- land from coastline ----
    coast = [LineString([(p["lon"], p["lat"]) for p in w["geometry"]]) for w in ways.values()
             if w.get("tags", {}).get("natural") == "coastline" and len(w.get("geometry", [])) > 1]
    merged = linemerge(unary_union(coast))
    lines = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    print("coast lines after merge", len(lines))
    noded = unary_union(lines + [clip.exterior])
    faces = [p for p in polygonize(noded) if p.intersects(clip)]
    sea_pts = [Point(*p) for p in SEA_POINTS]
    sea = [p for p in faces if any(p.contains(s) for s in sea_pts)]
    print("faces", len(faces), "sea faces", len(sea))
    land = clip.difference(unary_union(sea)) if sea else clip
    land = land.simplify(0.00012, preserve_topology=True)
    polys = list(land.geoms) if hasattr(land, "geoms") else [land]
    polys = [p for p in polys if p.area > 2e-7]  # drop specks (~1500 m2)
    land_fc = fc([{"type": "Feature", "properties": {}, "geometry": rnd_geom(p)} for p in polys])

    # ---- lakes ----
    water = []
    for w in ways.values():
        t = w.get("tags", {})
        g = w.get("geometry", [])
        if t.get("natural") == "water" and len(g) > 3 and g[0] == g[-1]:
            try:
                p = Polygon([(q["lon"], q["lat"]) for q in g])
                if p.is_valid and p.area > 3e-7:
                    water.append(p)
            except Exception:
                pass
    for r in rels.values():
        outers = [m for m in r.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
        inners = [m for m in r.get("members", []) if m.get("role") == "inner" and m.get("geometry")]
        try:
            o = list(polygonize(linemerge([LineString([(q["lon"], q["lat"]) for q in m["geometry"]]) for m in outers])))
            i = list(polygonize(linemerge([LineString([(q["lon"], q["lat"]) for q in m["geometry"]]) for m in inners]))) if inners else []
            g = unary_union(o)
            if i:
                g = g.difference(unary_union(i))
            if g.area > 3e-7:
                water.append(g)
        except Exception as ex:
            print("rel fail", r["id"], ex)
    wu = unary_union(water).intersection(clip).simplify(0.0001, preserve_topology=True)
    wpolys = list(wu.geoms) if hasattr(wu, "geoms") else [wu]
    water_fc = fc([{"type": "Feature", "properties": {}, "geometry": rnd_geom(p)} for p in wpolys if not p.is_empty])

    # ---- rivers ----
    riv = [LineString([(p["lon"], p["lat"]) for p in w["geometry"]]) for w in ways.values()
           if w.get("tags", {}).get("waterway") == "river" and len(w.get("geometry", [])) > 1]
    rm = linemerge(unary_union(riv)).intersection(clip).simplify(0.0001)
    rlines = list(rm.geoms) if hasattr(rm, "geoms") else [rm]
    rivers_fc = fc([{"type": "Feature", "properties": {}, "geometry": rnd_geom(l)} for l in rlines if not l.is_empty])

    # ---- roads ----
    by_class = {}
    for w in ways.values():
        c = ROAD_CLASS.get(w.get("tags", {}).get("highway"))
        if c and len(w.get("geometry", [])) > 1:
            by_class.setdefault(c, []).append(LineString([(p["lon"], p["lat"]) for p in w["geometry"]]))
    road_feats = []
    for c in sorted(by_class, reverse=True):  # draw minor first
        m = linemerge(unary_union(by_class[c])).intersection(clip).simplify(0.00008)
        for l in (m.geoms if hasattr(m, "geoms") else [m]):
            if not l.is_empty and l.geom_type == "LineString":
                road_feats.append({"type": "Feature", "properties": {"c": c}, "geometry": rnd_geom(l)})
    roads_fc = fc(road_feats)

    # ---- places ----
    pf = []
    for n in nodes.values():
        t = n.get("tags", {})
        r = PLACE_RANK.get(t.get("place"))
        name = t.get("name")
        if r and name and clip.contains(Point(n["lon"], n["lat"])):
            pf.append({"type": "Feature", "properties": {"n": name, "r": r, "k": t.get("place")},
                       "geometry": {"type": "Point", "coordinates": [round(n["lon"], 4), round(n["lat"], 4)]}})
    places_fc = fc(sorted(pf, key=lambda f: f["properties"]["r"]))

    os.makedirs(OUT, exist_ok=True)
    for name, obj in [("land", land_fc), ("water", water_fc), ("rivers", rivers_fc), ("roads", roads_fc), ("places", places_fc)]:
        p = os.path.join(OUT, name + ".json")
        with open(p, "w") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(name, len(obj["features"]), os.path.getsize(p) // 1024, "KB")


if __name__ == "__main__":
    main(sys.argv[1])
