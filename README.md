# Vaasa area trails

A client-side map of nature and hiking trails in Vaasa (incl. Vähäkyrö), Korsholm, Malax, Laihia, Isokyrö and Vörå.
It is plain HTML/JS with Leaflet (`vendor/leaflet.js`, 1.9.4) and has no build step for the app itself.

- Full version, with the map tiles: GitHub Pages, https://pohjoiseen.github.io/trails/ (Settings → Pages → deploy from branch, root folder; `.nojekyll` is included).
- The same files are published as a Claude artifact. Artifacts block external images, so tiles don't load there; the page then shows a link to the full version.

## Layout

| Path | What |
|---|---|
| `index.html` | Page shell, styles (Leaflet CSS inlined) |
| `coat-of-arms.svg` | Vaasa coat of arms (public domain, from Wikimedia Commons) |
| `app.js` | App logic: map, filters, list, detail, photos, phone bottom sheet |
| `i18n.js` | UI strings in English, Finnish, Swedish and Russian |
| `data/trails.json` | Trail index with simplified overview lines (loaded at start) |
| `data/tracks/<id>.json` | Full-detail tracks, loaded when a trail is opened |
| `data/text/<lang>.json` | Descriptions per language, loaded on demand |
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

OpenFreeMap vector tiles (OpenStreetMap data, no API key, drawn with MapLibre GL so they stay sharp on high-DPI screens; MapLibre is loaded only for this layer), with classic OSM raster tiles and the Maanmittauslaitos topographic map (open WMTS API, key in `app.js`) as alternatives. Base layers are defined in `BASES` in `app.js`.

## Track clean-up

`build_data.py` merges all sources for a trail, removes stretches that retrace already-drawn path
(out-and-back sections, overlapping routes of a network, near-parallel duplicates within 12 m) and simplifies the result.
Set `"keep_duplicates": true` in a trail's `geometry` to skip this.

## Data sources

Municipal trail pages and maps, luontoon.fi (Metsähallitus), the Lipas sports facility database (University of Jyväskylä),
City of Vaasa open map layers, and OpenStreetMap (© OpenStreetMap contributors, ODbL).
