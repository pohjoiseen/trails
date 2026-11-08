# Vaasa area trails

A client-side map of nature and hiking trails in Vaasa (incl. Vähäkyrö), Korsholm, Malax, Laihia, Isokyrö and Vörå.
It is plain HTML/JS with Leaflet from cdnjs and has no build step for the app itself. It runs from any static host and as a Claude artifact.

## Layout

| Path | What |
|---|---|
| `index.html` | Page shell, styles (Leaflet CSS inlined) |
| `app.js` | App logic: map, filters, list, detail, photos, phone bottom sheet |
| `i18n.js` | UI strings in English, Finnish, Swedish and Russian |
| `data/trails.json` | Trail index with simplified overview lines (loaded at start) |
| `data/tracks/<id>.json` | Full-detail tracks, loaded when a trail is opened |
| `data/text/<lang>.json` | Descriptions per language, loaded on demand |
| `data/basemap/*.json` | Self-hosted simplified OSM basemap (see below) |
| `data-src/` | Curated source data: edit this, then rebuild |
| `photos/` | Trail photos (none yet; see `photos/README.md`) |
| `tools/` | Build scripts |

## Editing trails

Edit `data-src/trails.json` (metadata, parking, geometry recipe, `rating`, `photos`) and `data-src/text/<lang>.json`
(descriptions, highlights, notes), then run:

```bash
python3 tools/build_data.py
```

- `rating`: `null` or 1–3. The rating filter and sort appear once any trail has a rating.
- `kind`: `loop`, `linear`, `network` or `loop+linear`. `length_km` is `[min, max]`.
- `geometry`: any mix of `lipas_ids` (with optional `lipas_parts`), `osm` (`way/…`, `relation/…`), `file` (GeoJSON or GPX under
  `data-src/geometry/files/`), `waypoints` (`[[lat, lon], …]`), and `quality` (`exact`, `approx`, `partial` or `none`).
  Raw downloads are cached in `data-src/geometry/`.

## Base map

On normal hosting the app uses OpenStreetMap raster tiles. Claude artifacts block images from other hosts, so when tiles fail
the app switches to a simplified vector map built from OpenStreetMap extracts:

```bash
curl -O https://download.openstreetmap.fr/extracts/europe/finland/ostrobothnia-latest.osm.pbf
curl -O https://download.openstreetmap.fr/extracts/europe/finland/south_ostrobothnia-latest.osm.pbf
pip install osmium shapely
python3 tools/build_basemap.py ostrobothnia-latest.osm.pbf south_ostrobothnia-latest.osm.pbf
```

A Maanmittauslaitos topographic layer can be added in `BASES` in `app.js`; it needs an API key.

## Data sources

Municipal trail pages and maps, luontoon.fi (Metsähallitus), the Lipas sports facility database (University of Jyväskylä),
City of Vaasa open map layers, and OpenStreetMap (© OpenStreetMap contributors, ODbL).
