#!/usr/bin/env python3
"""One-off: merge research/<muni>/trails.json files into data-src/trails.json + data-src/text/en.json.

Kept for reference: data-src/ is the source of truth after the initial import and is edited by hand.
Usage: merge_research.py <research-dir>
"""
import json, os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = sys.argv[1]
GEO = os.path.join(ROOT, "data-src", "geometry", "files")
ORDER = ["vaasa", "korsholm", "malax", "laihia", "isokyro", "vora"]
LOCAL_SV = {"korsholm", "malax", "vora"}

# Trails dropped from the import (reason in comment)
DROP = {
    "vaasa-luontoliikuntareitisto",       # umbrella for urban path network; Pilvilampi and City Bay listed separately
    "vaasa-onkilahti-accessible-trail",   # 220 m boardwalk in a city park
}

# Geometry decisions where a research entry offers several sources. Paths relative to research dir.
GEOM = {
    "bjorko-panike-trail": {"lipas_ids": [515798, 620880]},  # luontoon GPX also contains Vargis (separate entry)
    "bodvattnet-runt": {"file": "korsholm/dl/geo_bodvattnet-runt-mustasaari-62410.geojson"},
    "vargis-trails": {"file": "korsholm/dl/geo_vargis-kesaretkeilyreitti-mustasaari-127042.geojson"},
    "valsorarna-nature-trail": {"file": "korsholm/dl/geo_valsorarnas-natur-och-kulturstig-mustasaari-70006.geojson"},
    "sommaro-nature-trails": {"lipas_ids": [515795]},
    "kikanberget": {"osm": ["relation/21307229"]},
    "petsmo-trail": {"osm": ["relation/13324856"]},
    "soderfjarden-trail": {"osm": ["relation/20300529", "relation/20300530", "relation/20300531", "relation/20300532"]},
    "malsorleden": {"lipas_ids": [617746, 617748, 618925]},
    "vora-arvidsstigen-vernersstigen": {"osm": ["relation/21232723", "relation/21232724"]},
    "vora-kimo-river-mouth-bird-towers": {"osm": ["way/118873548", "way/118873476"]},
    "vora-kimo-bruk-trails": {"quality": "none"},
    "vora-vitmossen": {"lipas_ids": [606566], "lipas_parts": {"606566": [i for i in range(61) if i not in [34, 36, 37] + list(range(43, 61))]}},
    "vora-mickelsorarna-nature-trail": {"file": "vora/dl/mick_geom.json"},
    "vora-rokio-norrvalla-boberget": {"lipas_ids": [606567, 606568]},
}
APPROX = {"vora-komossa-hoppamaki": "komossa", "vora-skidcentrum-trail": "skid", "vora-storberget": "storberget"}

FAC = [
    (r"lean|laavu|vindskydd", "laavu"), (r"half-kota|kota|kåta", "kota"), (r"fire|grill", "fireplace"),
    (r"toilet|dass", "toilet"), (r"tower|platform", "tower"), (r"duckboard", "duckboards"),
    (r"accessible|pushchair", "accessible"), (r"\bhut\b|day hut|autiotupa", "hut"), (r"info|board", "signs"),
    (r"swim|beach", "swimming"), (r"cooking shelter|rain shelter|shelter", "shelter"), (r"sauna", "sauna"),
    (r"caf", "cafe"), (r"tent", "tent"),
]


def facilities(lst):
    out = []
    for f in lst or []:
        for pat, key in FAC:
            if re.search(pat, f.lower()):
                if key not in out:
                    out.append(key)
                break
    return out


def copy_geo(rel, tid):
    src = os.path.join(RES, rel)
    os.makedirs(GEO, exist_ok=True)
    ext = os.path.splitext(src)[1].lower()
    dst = os.path.join(GEO, tid + (".gpx" if ext == ".gpx" else ".geojson"))
    shutil.copyfile(src, dst)
    return os.path.relpath(dst, ROOT)


def main():
    trails, text = [], {}
    approx = json.load(open(os.path.join(RES, "vora", "approx.json")))
    for muni in ORDER:
        p = os.path.join(RES, muni, "trails.json")
        if not os.path.exists(p):
            print("missing", muni)
            continue
        for t in json.load(open(p)):
            tid = t["id"]
            if tid in DROP:
                continue
            g = t.get("geometry", {})
            rec = dict(GEOM.get(tid, {}))
            if tid in APPROX:
                a = approx[APPROX[tid]]
                rec = {"waypoints": list(a.values()) if isinstance(a, dict) else a, "quality": "approx"}
            elif not rec:
                if g.get("file"):
                    rec = {"file": g["file"].replace("research/", "", 1)}
                elif muni == "isokyro" and g.get("url", "").lower().endswith(".gpx"):
                    fn = os.path.basename(g["url"]).replace(".GPX", ".gpx")
                    cand = [f for f in os.listdir(os.path.join(RES, "isokyro", "dl")) if f.lower() == fn.lower()]
                    rec = {"file": "isokyro/dl/" + cand[0]} if cand else {"lipas_ids": g.get("lipas_ids", [])}
                elif g.get("source") == "osm" and g.get("osm"):
                    rec = {"osm": g["osm"]}
                elif g.get("lipas_ids"):
                    rec = {"lipas_ids": g["lipas_ids"]}
                    if g.get("lipas_parts"):
                        rec["lipas_parts"] = g["lipas_parts"]
                elif g.get("waypoints"):
                    rec = {"waypoints": g["waypoints"], "quality": "approx"}
                elif g.get("osm"):
                    rec = {"osm": g["osm"]}
                if g.get("source") == "approx":
                    rec["quality"] = "approx"
            if rec.get("file"):
                rec["file"] = copy_geo(rec["file"], tid)
            parking = [{"lat": round(x["lat"], 5), "lon": round(x["lon"], 5), "address": x.get("address", "")} for x in (t.get("parking") or []) if x.get("lat")]
            name = dict(t.get("name", {}))
            rec_out = {
                "id": tid,
                "municipality": muni,
                "area": t.get("area"),
                "name": {k: v for k, v in name.items() if k in ("fi", "sv", "en") and v},
                "local": "sv" if muni in LOCAL_SV else "fi",
                "kind": t["kind"],
                "length_km": t["length_km"],
                "rating": None,
                "parking": parking,
                "facilities": facilities(t.get("facilities")),
                "photos": [],
                "geometry": rec,
                "borderline": bool(t.get("borderline")),
                "sources": t.get("sources", []),
            }
            trails.append(rec_out)
            text[tid] = {k: v for k, v in {
                "desc": t.get("description_en", "").strip(),
                "highlights": t.get("highlights") or [],
                "network_note": t.get("network_note"),
                "duration": t.get("duration_note"),
                "access": t.get("access_note"),
                "season": t.get("season_note"),
                "parking_notes": [x.get("note", "") for x in (t.get("parking") or []) if x.get("lat")],
            }.items() if v}
    json.dump(trails, open(os.path.join(ROOT, "data-src", "trails.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(text, open(os.path.join(ROOT, "data-src", "text", "en.json"), "w"), ensure_ascii=False, indent=1)
    print(len(trails), "trails")


if __name__ == "__main__":
    main()
