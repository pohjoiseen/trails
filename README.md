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
| `tools/` | Build scripts |
| `tools/editor/` | Local editor for ratings and photos (not part of the site) |

## Editing trails

Edit `data-src/trails.json` (metadata, parking, geometry recipe, `rating`, `photos`) and `data-src/text/<lang>.json`
(descriptions, highlights, notes), then run:

```bash
python3 tools/build_data.py
```

- `rating`: `null` or 1–5. The rating filter and sort appear once any trail has a rating.
- `photos`: `[{"id", "thumb", "src", "date"}, …]`, the photo IDs and URLs from the blog's photo archive (`thumb` is
  the 375 px thumbnail shown in the strip, `src` the full-size photo shown in the lightbox). Use the editor below rather than editing by hand.
- `kind`: `loop`, `linear`, `network` or `loop+linear`. `length_km` is `[min, max]`.
- `geometry`: any mix of `lipas_ids` (with optional `lipas_parts`), `osm` (`way/…`, `relation/…`), `file` (GeoJSON or GPX under
  `data-src/geometry/files/`), `waypoints` (`[[lat, lon], …]`), and `quality` (`exact`, `approx`, `partial` or `none`).
  Raw downloads are cached in `data-src/geometry/`.

## Ratings and photos editor

```bash
python3 tools/editor/editor.py
```

Then open http://127.0.0.1:8765/. Trails are on the left: pick one, set its rating (click the stars or press 0–5), drag
its photos to reorder them, × removes one. The right side browses the photo archive in a copy of the pohjoiseen blog
database by folder (or search folders by name): click a photo to add or remove it, ⤢ or double-click for full screen
(←/→ to move, Space to add or remove), or drag it into the trail at a given position. **Save & rebuild** (Ctrl+S)
writes `data-src/trails.json` (only `rating` and `photos`) and runs `tools/build_data.py`.

The database is taken from `$POHJOISEEN_DB`, otherwise the newest `pohjoiseen*.db` at the repository root (git-ignored).
It is opened read-only. `PORT` changes the port. The editor only listens on localhost and has no HTML file of its own,
so GitHub Pages has no page to show for it.

## Base map

OpenFreeMap vector tiles (OpenStreetMap data, no API key, drawn with MapLibre GL so they stay sharp on high-DPI screens; MapLibre is loaded only for this layer), with classic OSM raster tiles and the Maanmittauslaitos topographic map (open WMTS API, key in `app.js`) as alternatives. Base layers are defined in `BASES` in `app.js`.

## Track clean-up

`build_data.py` merges all sources for a trail, removes stretches that retrace already-drawn path
(out-and-back sections, overlapping routes of a network, near-parallel duplicates within 12 m) and simplifies the result.
Set `"keep_duplicates": true` in a trail's `geometry` to skip this.

## Data sources

Municipal trail pages and maps, luontoon.fi (Metsähallitus), the Lipas sports facility database (University of Jyväskylä),
City of Vaasa open map layers, and OpenStreetMap (© OpenStreetMap contributors, ODbL).
