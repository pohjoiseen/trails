# Trail photos

Put photo files here (e.g. `photos/bodvattnet/01.jpg`, plus an optional smaller `01-thumb.jpg`)
and list them on the trail in `data-src/trails.json`:

```json
"photos": [
  {"src": "photos/bodvattnet/01.jpg", "thumb": "photos/bodvattnet/01-thumb.jpg",
   "caption": {"en": "Duckboards over the fen", "fi": "Pitkospuut suon yli"},
   "date": "2023-06", "credit": "Author"}
]
```

Then run `python3 tools/build_data.py`. The detail view shows a photo strip and a lightbox when a trail has photos.
Keep files reasonably small (about 1600 px long edge, 200–400 KB) since the artifact is limited to 256 MB in total.
