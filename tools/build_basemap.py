#!/usr/bin/env python3
"""Build the simplified vector basemap (data/basemap/*.json) from regional OSM extracts.

The Claude artifact sandbox blocks external images, so OSM raster tiles cannot load there.
This produces a light self-hosted map: land, forest, wetland, built-up areas, lakes, rivers,
main roads and place names. Data © OpenStreetMap contributors (ODbL).

Usage:
  curl -O https://download.openstreetmap.fr/extracts/europe/finland/ostrobothnia-latest.osm.pbf
  curl -O https://download.openstreetmap.fr/extracts/europe/finland/south_ostrobothnia-latest.osm.pbf
  build_basemap.py ostrobothnia-latest.osm.pbf south_ostrobothnia-latest.osm.pbf
Needs: osmium (pyosmium), shapely
"""
import json, os, sys
import osmium
from shapely import wkb
from shapely.geometry import LineString, Point, box, mapping
from shapely.ops import linemerge, polygonize, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "basemap")
BBOX = (20.55, 62.55, 23.35, 63.70)  # lon/lat
SEA_POINTS = [(20.6, 62.6), (20.6, 63.65), (21.2, 63.1), (21.05, 63.0)]
ROAD_CLASS = {"motorway": 1, "trunk": 1, "motorway_link": 1, "trunk_link": 1, "primary": 2, "primary_link": 2,
              "secondary": 3, "tertiary": 4, "unclassified": 5}
PLACE_RANK = {"city": 1, "town": 1, "suburb": 2, "village": 2, "hamlet": 3, "island": 3, "neighbourhood": 4, "islet": 4}
CLIP = box(*BBOX)
wkbf = osmium.geom.WKBFactory()


def inside(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.coast, self.rivers, self.roads, self.places = {}, {}, {}, {}
        self.areas = {"water": [], "forest": [], "wetland": [], "urban": []}
        self.seen_areas = set()

    def node(self, n):
        p = n.tags.get("place")
        if p in PLACE_RANK and "name" in n.tags and inside(n.location.lon, n.location.lat):
            self.places[n.id] = (n.location.lon, n.location.lat, n.tags["name"], PLACE_RANK[p], p)

    def way(self, w):
        t = w.tags
        kind = None
        if t.get("natural") == "coastline":
            kind = "coast"
        elif t.get("waterway") == "river":
            kind = "river"
        elif t.get("highway") in ROAD_CLASS:
            kind = "road"
        if not kind:
            return
        try:
            coords = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2 or not any(inside(*c) for c in coords):
            if kind != "coast" or not LineString(coords).intersects(CLIP):
                return
        if kind == "coast":
            self.coast[w.id] = coords
        elif kind == "river":
            self.rivers[w.id] = coords
        else:
            self.roads[w.id] = (coords, ROAD_CLASS[t["highway"]])

    def area(self, a):
        t = a.tags
        nat, lu = t.get("natural"), t.get("landuse")
        if nat == "water" or lu in ("reservoir", "basin"):
            cls = "water"
        elif lu == "forest" or nat == "wood":
            cls = "forest"
        elif nat == "wetland":
            cls = "wetland"
        elif lu in ("residential", "industrial", "commercial", "retail"):
            cls = "urban"
        else:
            return
        key = (a.from_way(), a.orig_id())
        if key in self.seen_areas:
            return
        try:
            g = wkb.loads(wkbf.create_multipolygon(a), hex=True)
        except Exception:
            return
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty or not g.intersects(CLIP):
            return
        self.seen_areas.add(key)
        self.areas[cls].append(g)


def rnd_geom(g, nd=5):
    m = mapping(g)

    def r(c):
        if isinstance(c[0], (float, int)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def polys_fc(g, min_area, tol):
    g = g.intersection(CLIP).simplify(tol, preserve_topology=True)
    parts = list(g.geoms) if hasattr(g, "geoms") else [g]
    feats = []
    for p in parts:
        if p.geom_type == "Polygon" and p.area >= min_area:
            # drop tiny holes
            from shapely.geometry import Polygon
            p = Polygon(p.exterior, [i for i in p.interiors if Polygon(i).area >= min_area])
            feats.append({"type": "Feature", "properties": {}, "geometry": rnd_geom(p)})
    return {"type": "FeatureCollection", "features": feats}


def lines_fc(lines, props=None, tol=0.0001):
    m = linemerge(unary_union(lines)).intersection(CLIP).simplify(tol)
    feats = []
    for l in (m.geoms if hasattr(m, "geoms") else [m]):
        if not l.is_empty and l.geom_type == "LineString":
            feats.append({"type": "Feature", "properties": props or {}, "geometry": rnd_geom(l)})
    return feats


def main(files):
    h = H()
    for f in files:
        print("reading", f)
        h.apply_file(f, locations=True)
    print("coast", len(h.coast), "rivers", len(h.rivers), "roads", len(h.roads), "places", len(h.places),
          {k: len(v) for k, v in h.areas.items()})

    # land = bbox minus sea faces (faces of coastline network containing known sea points)
    lines = [LineString(c) for c in h.coast.values()]
    merged = linemerge(unary_union(lines))
    noded = unary_union((list(merged.geoms) if hasattr(merged, "geoms") else [merged]) + [CLIP.exterior])
    faces = list(polygonize(noded))
    sea = [p for p in faces if any(p.contains(Point(*s)) for s in SEA_POINTS)]
    print("faces", len(faces), "sea faces", len(sea))
    land = CLIP.difference(unary_union(sea))
    out = {
        "land": polys_fc(land, 2e-7, 0.00012),
        "water": polys_fc(unary_union(h.areas["water"]), 3e-7, 0.0001),
        "forest": polys_fc(unary_union([g.buffer(0) for g in h.areas["forest"]]), 5e-6, 0.0004),
        "wetland": polys_fc(unary_union([g.buffer(0) for g in h.areas["wetland"]]), 2e-6, 0.0003),
        "urban": polys_fc(unary_union([g.buffer(0) for g in h.areas["urban"]]), 2e-6, 0.0002),
        "rivers": {"type": "FeatureCollection", "features": lines_fc([LineString(c) for c in h.rivers.values()])},
    }
    road_feats = []
    by_class = {}
    for coords, c in h.roads.values():
        by_class.setdefault(c, []).append(LineString(coords))
    for c in sorted(by_class, reverse=True):
        road_feats += lines_fc(by_class[c], {"c": c}, 0.00008)
    out["roads"] = {"type": "FeatureCollection", "features": road_feats}
    pf = [{"type": "Feature", "properties": {"n": n, "r": r, "k": k}, "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]}}
          for lon, lat, n, r, k in h.places.values()]
    out["places"] = {"type": "FeatureCollection", "features": sorted(pf, key=lambda f: f["properties"]["r"])}
    os.makedirs(OUT, exist_ok=True)
    for name, obj in out.items():
        p = os.path.join(OUT, name + ".json")
        with open(p, "w") as f:
            json.dump(compact(obj), f, ensure_ascii=False, separators=(",", ":"))
        print(name, len(obj["features"]), os.path.getsize(p) // 1024, "KB")


def compact(fc):
    """Delta-encode coordinates as integers (1e-4 deg). Decoded by decodeBase() in app.js.
    {"s":1e4,"f":[[props, ring, ring...]]}, ring = [x0,y0,dx1,dy1,...]; points are single-pair rings."""
    S = 10000

    def enc(coords):
        out, px, py = [], 0, 0
        for c in coords:
            x, y = round(c[0] * S), round(c[1] * S)
            out += [x - px, y - py]
            px, py = x, y
        return out
    feats = []
    for f in fc["features"]:
        g = f["geometry"]
        if g["type"] == "Polygon":
            rings = [enc(r) for r in g["coordinates"]]
        elif g["type"] == "LineString":
            rings = [enc(g["coordinates"])]
        else:
            rings = [enc([g["coordinates"]])]
        feats.append([f["properties"] or 0] + rings)
    kind = fc["features"][0]["geometry"]["type"] if fc["features"] else "Polygon"
    return {"s": S, "t": kind, "f": feats}


if __name__ == "__main__":
    main(sys.argv[1:])
