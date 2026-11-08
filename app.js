/* Vaasa area trails — client-side app. No build step; Leaflet is the only dependency. */
(function () {
  "use strict";
  const I = window.I18N;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- state ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("vat:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("vat:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const S = {
    lang: I.langs.includes(store.get("lang", "en")) ? store.get("lang", "en") : "en",
    trails: [],
    byId: {},
    text: {},          // lang -> {id: {...}}
    tracks: {},        // id -> detail geometry
    filter: { muni: [], len: null, kind: null, rating: null, q: "" },
    sort: store.get("sort", "name"),
    selected: null,
    hover: null,
    base: store.get("base", "osm"),
    tilesOk: null
  };
  const t = (k) => (I.strings[S.lang] && I.strings[S.lang][k]) ?? I.strings.en[k] ?? k;
  const tn = (k, n) => { const f = t(k); const form = I.plural(S.lang, n); return (f[form] || f.other).replace("{n}", n); };
  const muniName = (m) => (I.munis[m] && (I.munis[m][S.lang] || I.munis[m].en)) || m;

  /* ---------------- icons ---------------- */
  const ICON = {
    loop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M11.6 1.8v2.8H8.8"/></svg>',
    linear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="2.8" cy="8" r="1.6"/><circle cx="13.2" cy="8" r="1.6"/><path d="M4.6 8h6.8"/></svg>',
    network: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="3.5" r="1.4"/><circle cx="13" cy="4" r="1.4"/><circle cx="8" cy="8.5" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="12.5" cy="12.5" r="1.4"/><path d="M4.2 4.4 6.9 7.5M11.8 5 9.1 7.6M7 9.5l-2.4 2.5M9.1 9.5l2.3 2.2M4.4 3.6h7.2"/></svg>',
    "loop+linear": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="8" r="3.6"/><circle cx="2.2" cy="8" r="1.4"/><path d="M3.6 8h3.3"/></svg>',
    star: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="m8 1.2 2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
  };
  const stars = (n, showEmpty) => {
    if (!n && !showEmpty) return "";
    let h = '<span class="stars" title="' + esc(t("rating")) + (n ? ": " + n + "/3" : "") + '">';
    for (let i = 1; i <= 3; i++) h += '<span class="' + (i <= n ? "" : "off") + '">' + ICON.star + "</span>";
    return h + "</span>";
  };

  /* ---------------- formatting ---------------- */
  const fmtNum = (x) => {
    const r = x >= 10 ? Math.round(x) : Math.round(x * 10) / 10;
    return S.lang === "en" ? String(r) : String(r).replace(".", ",");
  };
  const fmtLen = (tr) => {
    const [a, b] = tr.length_km || [];
    if (a == null) return "?";
    return a === b || b == null ? fmtNum(a) : fmtNum(a) + "–" + fmtNum(b);
  };
  const kindHtml = (k) => '<span class="kind">' + (ICON[k] || "") + esc(t("kind_" + k)) + "</span>";
  const localName = (tr) => tr.name[tr.local] || tr.name.fi || tr.name.sv || tr.name.en;
  /* Primary name: the local-language name for en/ru; the viewer's language when fi/sv. */
  const primaryName = (tr) => {
    if (S.lang === "fi" || S.lang === "sv") return tr.name[S.lang] || localName(tr);
    return localName(tr);
  };
  const altName = (tr) => {
    const p = primaryName(tr);
    const others = ["fi", "sv"].map((l) => tr.name[l]).filter((n) => n && n !== p);
    return others[0] || "";
  };
  const textFor = (tr) => {
    const own = S.text[S.lang] && S.text[S.lang][tr.id];
    if (own && own.desc) return { ...own, fallback: false };
    const en = S.text.en && S.text.en[tr.id];
    return en ? { ...en, fallback: S.lang !== "en" } : null;
  };

  /* ---------------- data loading ---------------- */
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  async function loadText(lang) {
    if (S.text[lang]) return S.text[lang];
    try { S.text[lang] = await getJSON("data/text/" + lang + ".json"); }
    catch (e) { S.text[lang] = {}; }
    return S.text[lang];
  }
  async function loadTrack(id) {
    if (S.tracks[id]) return S.tracks[id];
    try { S.tracks[id] = await getJSON("data/tracks/" + id + ".json"); }
    catch (e) { S.tracks[id] = null; }
    return S.tracks[id];
  }

  /* ---------------- map ---------------- */
  let map, trackLayer, pinLayer, parkLayer, selLayer, simpleBase, osmLayer, canvas;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function initMap() {
    map = L.map("map", { zoomControl: false, attributionControl: true, minZoom: 7, maxZoom: 18, zoomSnap: 1, preferCanvas: false })
      .setView([63.08, 21.75], 9);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.attributionControl.setPrefix(false);
    canvas = L.canvas({ padding: 0.3, tolerance: 6 });
    map.createPane("base"); map.getPane("base").style.zIndex = 250;
    map.createPane("labels"); map.getPane("labels").style.zIndex = 380; map.getPane("labels").style.pointerEvents = "none";
    map.createPane("tracks"); map.getPane("tracks").style.zIndex = 420;
    map.createPane("sel"); map.getPane("sel").style.zIndex = 440;
    map.createPane("pins"); map.getPane("pins").style.zIndex = 620;
    trackLayer = L.layerGroup().addTo(map);
    selLayer = L.layerGroup().addTo(map);
    parkLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    map.on("zoomend", updatePins);
    map.on("click", () => { if (S.selected && isPhone()) setSheet("peek"); });
    setBase(S.base, true);
  }

  /* Base layers. OSM raster tiles where the host allows them; a self-hosted vector map otherwise
     (Claude artifacts block external images). Add more raster options to BASES, e.g. MML topo. */
  const BASES = {
    osm: { key: "layer_osm", make: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }) },
    simple: { key: "layer_simple" }
    // mml: { key: "layer_mml", make: () => L.tileLayer("https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/maastokartta/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png?api-key=YOUR_KEY", { maxZoom: 16, attribution: "&copy; Maanmittauslaitos" }) }
  };

  function setBase(key, initial) {
    if (!BASES[key]) key = "simple";
    if (key !== "simple" && S.tilesOk === false) key = "simple";
    S.base = key;
    if (!initial) store.set("base", key);
    if (osmLayer) { map.removeLayer(osmLayer); osmLayer = null; }
    if (key === "simple") { showSimpleBase(true); }
    else {
      showSimpleBase(false);
      osmLayer = BASES[key].make().addTo(map);
      probeTiles(osmLayer);
    }
    renderLayerMenu();
  }

  function probeTiles(layer) {
    let ok = 0, bad = 0, decided = S.tilesOk != null;
    layer.on("tileload", () => { ok++; if (!decided) { decided = true; S.tilesOk = true; } });
    layer.on("tileerror", () => {
      bad++;
      if (!decided && bad >= 2 && ok === 0) { decided = true; tilesFailed(); }
    });
    setTimeout(() => { if (!decided && ok === 0) { decided = true; tilesFailed(); } }, 6000);
  }
  function tilesFailed() {
    S.tilesOk = false;
    setBase("simple", true);
    toast(t("tilesBlocked"));
  }

  let simpleLoaded = false, simpleLoading = null, placeMarkers = [];
  async function showSimpleBase(on) {
    if (!on) { if (simpleBase) map.removeLayer(simpleBase); placeMarkers.forEach((m) => m.remove()); return; }
    if (!simpleLoaded) {
      simpleLoading = simpleLoading || buildSimpleBase();
      await simpleLoading;
    }
    if (S.base !== "simple") return;
    simpleBase.addTo(map);
    updatePlaces();
  }
  async function buildSimpleBase() {
    simpleBase = L.layerGroup();
    const files = ["land", "water", "rivers", "roads", "places"];
    const data = {};
    await Promise.all(files.map(async (f) => { try { data[f] = await getJSON("data/basemap/" + f + ".json"); } catch (e) { data[f] = null; } }));
    simpleBase._data = data;
    styleSimpleBase();
    simpleLoaded = true;
    map.on("zoomend moveend", updatePlaces);
  }
  function styleSimpleBase() {
    const d = simpleBase._data; simpleBase.clearLayers();
    const opt = { pane: "base", renderer: canvas, interactive: false };
    if (d.land) simpleBase.addLayer(L.geoJSON(d.land, { ...opt, style: { stroke: true, color: css("--map-land"), weight: 0.5, fillColor: css("--map-land"), fillOpacity: 1 } }));
    if (d.water) simpleBase.addLayer(L.geoJSON(d.water, { ...opt, style: { stroke: false, fillColor: css("--map-lake"), fillOpacity: 1 } }));
    if (d.rivers) simpleBase.addLayer(L.geoJSON(d.rivers, { ...opt, style: { color: css("--map-lake"), weight: 2.2 } }));
    if (d.roads) {
      simpleBase.addLayer(L.geoJSON(d.roads, { ...opt, style: (f) => ({ color: css("--map-road-case"), weight: f.properties.c <= 2 ? 4.5 : 3, opacity: 0.9 }) }));
      simpleBase.addLayer(L.geoJSON(d.roads, { ...opt, style: (f) => ({ color: f.properties.c <= 2 ? css("--map-road-major") : css("--map-road"), weight: f.properties.c <= 2 ? 3 : 1.6 }) }));
    }
    placeMarkers.forEach((m) => m.remove());
    placeMarkers = (d.places && d.places.features || []).map((f) => {
      const [lon, lat] = f.geometry.coordinates; const p = f.properties;
      const cls = p.r <= 1 ? "town" : p.k === "island" ? "island" : "";
      const m = L.marker([lat, lon], { pane: "labels", interactive: false, keyboard: false, icon: L.divIcon({ className: "", html: '<div class="place ' + cls + '">' + esc(p.n) + "</div>", iconSize: [0, 0] }) });
      m._minZoom = p.r <= 1 ? 7 : p.r === 2 ? 10 : p.r === 3 ? 12 : 13;
      return m;
    });
  }
  function updatePlaces() {
    if (!simpleLoaded || S.base !== "simple") return;
    const z = map.getZoom(), b = map.getBounds().pad(0.2);
    placeMarkers.forEach((m) => {
      const show = z >= m._minZoom && b.contains(m.getLatLng());
      if (show && !map.hasLayer(m)) m.addTo(map); else if (!show && map.hasLayer(m)) m.remove();
    });
  }

  /* trails on the map */
  const lineRefs = {}; // id -> [polyline]
  const pinRefs = {};
  function drawTrails() {
    trackLayer.clearLayers(); pinLayer.clearLayers();
    const col = css("--track");
    S.trails.forEach((tr) => {
      const lines = (tr.line || []).map((seg) => L.polyline(seg, {
        pane: "tracks", color: col, weight: 3, opacity: 0.85, dashArray: tr.geom_quality === "approx" ? "6 5" : null,
        lineCap: "round", lineJoin: "round", interactive: true, bubblingMouseEvents: false
      }));
      lines.forEach((pl) => {
        pl.on("click", () => select(tr.id, { fit: false }));
        pl.on("mouseover", () => setHover(tr.id)); pl.on("mouseout", () => setHover(null));
        pl.bindTooltip(() => tooltipHtml(tr), { sticky: true, className: "tt", direction: "top", offset: [0, -6] });
        trackLayer.addLayer(pl);
      });
      lineRefs[tr.id] = lines;
      const anchor = tr.pin || (tr.parking && tr.parking[0] && [tr.parking[0].lat, tr.parking[0].lon]) || tr.center;
      if (anchor) {
        const m = L.marker(anchor, { pane: "pins", icon: pinIcon(tr, false), riseOnHover: true, keyboard: false });
        m.on("click", () => select(tr.id, { fit: true }));
        m.on("mouseover", () => setHover(tr.id)); m.on("mouseout", () => setHover(null));
        m.bindTooltip(() => tooltipHtml(tr), { className: "tt", direction: "top", offset: [0, -10] });
        pinRefs[tr.id] = m;
      }
    });
    applyFilterToMap();
    updatePins();
  }
  function tooltipHtml(tr) {
    return "<b>" + esc(primaryName(tr)) + "</b><br>" + fmtLen(tr) + " " + t("km") + " · " + esc(t("kind_" + tr.kind));
  }
  function pinIcon(tr, sel) {
    const z = map ? map.getZoom() : 9;
    const dot = z < 10.5 && !sel;
    return L.divIcon({ className: "", iconSize: [0, 0], html: '<div class="pin' + (sel ? " sel" : "") + (dot ? " dot" : "") + '">' + (dot ? "" : fmtLen(tr)) + "</div>" });
  }
  function updatePins() {
    Object.entries(pinRefs).forEach(([id, m]) => m.setIcon(pinIcon(S.byId[id], id === S.selected)));
    updatePlaces();
  }
  function applyFilterToMap() {
    const vis = new Set(visibleTrails().map((x) => x.id));
    S.trails.forEach((tr) => {
      const on = vis.has(tr.id) || tr.id === S.selected;
      const pinOn = on && tr.id !== S.selected;
      (lineRefs[tr.id] || []).forEach((pl) => { if (on && !trackLayer.hasLayer(pl)) trackLayer.addLayer(pl); if (!on && trackLayer.hasLayer(pl)) trackLayer.removeLayer(pl); });
      const m = pinRefs[tr.id];
      if (m) { if (pinOn && !pinLayer.hasLayer(m)) pinLayer.addLayer(m); if (!pinOn && pinLayer.hasLayer(m)) pinLayer.removeLayer(m); }
    });
  }
  function setHover(id) {
    if (S.hover === id) return;
    const prev = S.hover; S.hover = id;
    [prev, id].forEach((x) => {
      if (!x) return;
      (lineRefs[x] || []).forEach((pl) => pl.setStyle({ weight: x === id ? 5 : 3, opacity: x === id ? 1 : 0.85 }));
      const card = document.querySelector('.card[data-id="' + x + '"]');
      if (card) card.classList.toggle("hover", x === id);
    });
  }
  async function drawSelection(tr, fit) {
    selLayer.clearLayers(); parkLayer.clearLayers();
    if (!tr) return;
    const detail = await loadTrack(tr.id);
    if (S.selected !== tr.id) return;
    const segs = (detail && detail.lines) || tr.line || [];
    const dash = tr.geom_quality === "approx" ? "8 7" : null;
    segs.forEach((seg) => {
      selLayer.addLayer(L.polyline(seg, { pane: "sel", color: css("--track-case"), weight: 9, opacity: 0.9, lineCap: "round", lineJoin: "round", interactive: false }));
      selLayer.addLayer(L.polyline(seg, { pane: "sel", color: css("--track"), weight: 5, opacity: 1, dashArray: dash, lineCap: "round", lineJoin: "round", interactive: false }));
    });
    (tr.parking || []).forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], { pane: "pins", icon: L.divIcon({ className: "", iconSize: [0, 0], html: '<div class="pmark">P</div>' }), zIndexOffset: 1000 });
      m.bindTooltip("<b>" + esc(t("parking")) + "</b><br>" + esc(p.address || ""), { className: "tt", direction: "top", offset: [0, -12] });
      parkLayer.addLayer(m);
    });
    if (fit) fitTrail(tr, segs);
  }
  function fitTrail(tr, segs) {
    const pts = [].concat(...(segs || tr.line || []));
    (tr.parking || []).forEach((p) => pts.push([p.lat, p.lon]));
    if (!pts.length) return;
    const b = L.latLngBounds(pts);
    map.fitBounds(b, { paddingTopLeft: [30, 60], paddingBottomRight: [60, isPhone() ? sheetPx() + 30 : 40], maxZoom: 15.5 });
  }
  function fitAll() {
    const pts = [];
    visibleTrails().forEach((tr) => { if (tr.bbox) { pts.push(tr.bbox[0], tr.bbox[1]); } });
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 60], paddingBottomRight: [60, isPhone() ? sheetPx() + 20 : 30], maxZoom: 14 });
  }

  /* ---------------- filters & list ---------------- */
  const LEN = { s: [0, 3], m: [3, 6], l: [6, 12], xl: [12, 1e9] };
  function matches(tr, f) {
    if (f.muni.length && !f.muni.includes(tr.municipality)) return false;
    if (f.kind && !(tr.kind === f.kind || (f.kind !== "network" && tr.kind === "loop+linear" && (f.kind === "loop" || f.kind === "linear")))) return false;
    if (f.len) {
      const [lo, hi] = LEN[f.len]; const [a, b] = tr.length_km || [0, 0];
      if (!(a < hi && (b == null ? a : b) >= lo)) return false;
    }
    if (f.rating && !((tr.rating || 0) >= f.rating)) return false;
    if (f.q) {
      const txt = textFor(tr);
      const hay = [tr.name.fi, tr.name.sv, tr.name.en, tr.area, muniName(tr.municipality), txt && txt.desc].join(" ").toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  const collator = () => new Intl.Collator(S.lang === "ru" ? "fi" : S.lang, { sensitivity: "base" });
  function visibleTrails() {
    const list = S.trails.filter((tr) => matches(tr, S.filter));
    const c = collator();
    const byName = (a, b) => c.compare(primaryName(a), primaryName(b));
    const sorters = {
      name: byName,
      length: (a, b) => (a.length_km[0] + (a.length_km[1] ?? a.length_km[0])) - (b.length_km[0] + (b.length_km[1] ?? b.length_km[0])) || byName(a, b),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byName(a, b),
      muni: (a, b) => c.compare(muniName(a.municipality), muniName(b.municipality)) || byName(a, b)
    };
    return list.sort(sorters[S.sort] || byName);
  }
  const hasRatings = () => S.trails.some((tr) => tr.rating);

  function renderFilters() {
    const f = S.filter;
    const chip = (group, val, label, pressed, extra = "") => '<button class="chip" data-g="' + group + '" data-v="' + esc(val) + '" aria-pressed="' + pressed + '">' + extra + esc(label) + "</button>";
    const munis = Object.keys(I.munis).filter((m) => S.trails.some((tr) => tr.municipality === m));
    let h = '<div class="frow"><span class="flabel">' + esc(t("municipality")) + "</span>" + chip("muni", "", t("allMunis"), !f.muni.length) +
      munis.map((m) => chip("muni", m, muniName(m), f.muni.includes(m))).join("") + "</div>";
    h += '<div class="frow"><span class="flabel">' + esc(t("length")) + "</span>" + chip("len", "", t("anyLength"), !f.len) +
      Object.keys(LEN).map((k) => chip("len", k, t("len_" + k), f.len === k)).join("") + "</div>";
    h += '<div class="frow"><span class="flabel">' + esc(t("type")) + "</span>" + chip("kind", "", t("anyType"), !f.kind) +
      ["loop", "linear", "network"].map((k) => chip("kind", k, t("kind_" + k), f.kind === k, ICON[k])).join("") + "</div>";
    if (hasRatings()) {
      h += '<div class="frow"><span class="flabel">' + esc(t("rating")) + "</span>" + chip("rating", "", t("anyRating"), !f.rating) +
        [2, 3].map((n) => chip("rating", n, n === 3 ? "" : "+", f.rating === n, stars(n))).join("") + "</div>";
    }
    $("#filters").innerHTML = h;
  }
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const g = b.dataset.g, v = b.dataset.v;
    if (g === "muni") {
      if (!v) S.filter.muni = [];
      else S.filter.muni = S.filter.muni.includes(v) ? S.filter.muni.filter((x) => x !== v) : [...S.filter.muni, v];
    } else if (g === "rating") S.filter.rating = v ? +v : null;
    else S.filter[g] = v && S.filter[g] !== v ? v : null;
    refresh();
  });
  let qTimer;
  $("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value.trim(); refresh(); }, 120); });

  function renderSort() {
    const opts = ["name", "length", "muni"].concat(hasRatings() ? ["rating"] : []);
    if (!opts.includes(S.sort)) S.sort = "name";
    $("#sort").innerHTML = opts.map((o) => '<option value="' + o + '"' + (o === S.sort ? " selected" : "") + ">" + esc(t("sort_" + o)) + "</option>").join("");
    $("#t-sort").textContent = t("sort");
  }
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; store.set("sort", S.sort); renderList(); });

  function renderList() {
    const vis = visibleTrails();
    $("#count").textContent = tn("trails", vis.length);
    if (!vis.length) {
      $("#list").innerHTML = '<li class="empty">' + esc(t("noResults")) + '<button class="btn" id="clear">' + esc(t("clearFilters")) + "</button></li>";
      return;
    }
    $("#list").innerHTML = vis.map((tr) => {
      const alt = altName(tr);
      return '<li class="card" data-id="' + tr.id + '" tabindex="0">' +
        '<div class="nm">' + esc(primaryName(tr)) + (alt ? " <small>" + esc(alt) + "</small>" : "") + "</div>" +
        '<div class="len"><b>' + fmtLen(tr) + "<small>" + esc(t("km")) + "</small></b>" + kindHtml(tr.kind) + "</div>" +
        '<div class="meta"><span>' + esc(muniName(tr.municipality)) + (tr.area && tr.area !== muniName(tr.municipality) ? " · " + esc(tr.area) : "") + "</span>" + stars(tr.rating) + "</div>" +
        "</li>";
    }).join("");
  }
  $("#list").addEventListener("click", (e) => {
    if (e.target.id === "clear") { S.filter = { muni: [], len: null, kind: null, rating: null, q: "" }; $("#q").value = ""; refresh(); return; }
    const c = e.target.closest(".card"); if (c) select(c.dataset.id, { fit: true });
  });
  $("#list").addEventListener("keydown", (e) => { if (e.key === "Enter") { const c = e.target.closest(".card"); if (c) select(c.dataset.id, { fit: true }); } });
  $("#list").addEventListener("mouseover", (e) => { const c = e.target.closest(".card"); setHover(c ? c.dataset.id : null); });
  $("#list").addEventListener("mouseleave", () => setHover(null));

  function refresh() { renderFilters(); renderSort(); renderList(); applyFilterToMap(); }

  /* ---------------- detail ---------------- */
  function linkLabel(u) {
    try { const x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname.length > 1 ? decodeURIComponent(x.pathname).replace(/\/$/, "").slice(0, 48) : ""); } catch (e) { return u; }
  }
  function renderDetail(tr) {
    const tx = textFor(tr) || {};
    const alt = altName(tr);
    const desc = (tx.desc || "").split(/\n\s*\n/).filter(Boolean).map((p) => "<p>" + esc(p) + "</p>").join("");
    let h = '<button class="back" id="back">' + ICON.back + esc(t("back")) + "</button>";
    h += '<div class="dh"><h2>' + esc(primaryName(tr)) + "</h2>" + (alt ? '<div class="alt">' + esc(alt) + "</div>" : "") +
      '<div class="where">' + esc(muniName(tr.municipality)) + (tr.area ? " · " + esc(tr.area) : "") + " " + (tr.rating ? stars(tr.rating) : '<span class="stars" style="color:var(--muted);font-size:.78rem">' + esc(t("notRated")) + "</span>") + "</div></div>";
    h += '<div class="facts"><div class="big"><b>' + fmtLen(tr) + "<small>" + esc(t("km")) + "</small></b><span>" + esc(t("length")) + "</span></div>" +
      '<div class="kd">' + kindHtml(tr.kind) + "<p>" + esc(t("kindLong_" + tr.kind)) + "</p>" +
      (tr.kind === "network" && tx.network_note ? "<p><b>" + esc(t("networkExtent")) + ":</b> " + esc(tx.network_note) + "</p>" : "") +
      (tx.duration ? "<p>" + esc(tx.duration) + "</p>" : "") + "</div></div>";
    if (tr.photos && tr.photos.length) {
      h += '<div class="sec"><h3>' + esc(t("photos")) + '</h3><div class="gallery">' +
        tr.photos.map((p, i) => '<button data-photo="' + i + '" aria-label="' + esc(photoCaption(p) || t("photos")) + '"><img loading="lazy" src="' + esc(p.thumb || p.src) + '" alt="' + esc(photoCaption(p)) + '"></button>').join("") + "</div></div>";
    }
    if (tx.fallback) h += '<div class="note">' + esc(t("fallbackText")) + "</div>";
    if (desc) h += '<div class="desc">' + desc + "</div>";
    if (tr.geom_quality === "approx") h += '<div class="note">' + esc(t("approxTrack")) + "</div>";
    if (tr.geom_quality === "partial") h += '<div class="note">' + esc(t("partialTrack")) + "</div>";
    if (tx.highlights && tx.highlights.length) h += '<div class="sec"><h3>' + esc(t("highlights")) + "</h3><ul>" + tx.highlights.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>";
    if (tr.facilities && tr.facilities.length) h += '<div class="sec"><h3>' + esc(t("facilities")) + '</h3><div class="tags">' + tr.facilities.map((f) => '<span class="tag">' + esc((I.facilities[f] && (I.facilities[f][S.lang] || I.facilities[f].en)) || f) + "</span>").join("") + "</div></div>";
    if (tx.access) h += '<div class="sec"><h3>' + esc(t("access")) + "</h3><p style=\"margin:0\">" + esc(tx.access) + "</p></div>";
    if (tx.season) h += '<div class="sec"><h3>' + esc(t("season")) + "</h3><p style=\"margin:0\">" + esc(tx.season) + "</p></div>";
    if (tr.parking && tr.parking.length) {
      h += '<div class="sec"><h3>' + esc(t("parking")) + '</h3><div class="park">' + tr.parking.map((p, i) => {
        const note = tx.parking_notes && tx.parking_notes[i];
        const g = "https://www.google.com/maps/dir/?api=1&destination=" + p.lat + "," + p.lon;
        const o = "https://www.openstreetmap.org/?mlat=" + p.lat + "&mlon=" + p.lon + "#map=16/" + p.lat + "/" + p.lon;
        return '<div class="p"><button class="pi" data-park="' + i + '" aria-label="' + esc(t("parking")) + '">P</button><div>' +
          '<div class="pa">' + esc(p.address || "") + "</div>" + (note ? '<div class="pn">' + esc(note) + "</div>" : "") +
          '<div class="coords">' + p.lat.toFixed(5) + ", " + p.lon.toFixed(5) + "</div>" +
          '<div class="links"><a class="btn" href="' + g + '" target="_blank" rel="noopener">' + esc(t("directions")) + '</a><a class="btn" href="' + o + '" target="_blank" rel="noopener">' + esc(t("openOsm")) + "</a></div></div></div>";
      }).join("") + "</div></div>";
    }
    if (tr.sources && tr.sources.length) h += '<div class="sec srcs"><h3>' + esc(t("sources")) + "</h3><ul>" + tr.sources.map((u) => '<li><a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(linkLabel(u)) + "</a></li>").join("") + "</ul></div>";
    const dv = $("#detailview");
    dv.innerHTML = '<div class="detail">' + h + "</div>";
  }
  $("#detailview").addEventListener("click", (e) => {
    if (e.target.closest("#back")) { select(null); return; }
    const pk = e.target.closest("[data-park]");
    if (pk) { const p = S.byId[S.selected].parking[+pk.dataset.park]; map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15)); if (isPhone()) setSheet("peek"); return; }
    const ph = e.target.closest("[data-photo]");
    if (ph) openLightbox(S.byId[S.selected], +ph.dataset.photo);
  });

  /* ---------------- photos ---------------- */
  const photoCaption = (p) => (p.caption && (p.caption[S.lang] || p.caption.en)) || "";
  let lb = null;
  function openLightbox(tr, i) {
    lb = { tr, i };
    const el = $("#lightbox"); el.hidden = false; renderLightbox();
    $(".x", el).focus();
  }
  function renderLightbox() {
    const el = $("#lightbox"); const ps = lb.tr.photos; const p = ps[lb.i];
    const cap = [photoCaption(p), p.date, p.credit].filter(Boolean).join(" · ");
    el.innerHTML = '<img src="' + esc(p.src) + '" alt="' + esc(photoCaption(p)) + '"><div class="cap">' + esc(cap) + " (" + (lb.i + 1) + "/" + ps.length + ")</div>" +
      '<button class="lb x" aria-label="' + esc(t("close")) + '">' + ICON.x + "</button>" +
      (ps.length > 1 ? '<button class="lb pv" aria-label="' + esc(t("prev")) + '">' + ICON.back + '</button><button class="lb nx" aria-label="' + esc(t("next")) + '">' + ICON.next + "</button>" : "");
  }
  function closeLightbox() { $("#lightbox").hidden = true; $("#lightbox").innerHTML = ""; lb = null; }
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target.closest(".x") || e.target.id === "lightbox") return closeLightbox();
    if (e.target.closest(".pv")) { lb.i = (lb.i - 1 + lb.tr.photos.length) % lb.tr.photos.length; renderLightbox(); }
    if (e.target.closest(".nx")) { lb.i = (lb.i + 1) % lb.tr.photos.length; renderLightbox(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!lb) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") { lb.i = (lb.i - 1 + lb.tr.photos.length) % lb.tr.photos.length; renderLightbox(); }
    if (e.key === "ArrowRight") { lb.i = (lb.i + 1) % lb.tr.photos.length; renderLightbox(); }
  });

  /* ---------------- selection & routing ---------------- */
  let listScroll = 0;
  function select(id, opts = {}) {
    const prev = S.selected;
    if (id && !S.byId[id]) id = null;
    if (!prev && id) listScroll = $("#scroll").scrollTop;
    S.selected = id;
    if (prev && pinRefs[prev]) pinRefs[prev].setIcon(pinIcon(S.byId[prev], false));
    if (id && pinRefs[id]) pinRefs[id].setIcon(pinIcon(S.byId[id], true));
    applyFilterToMap();
    if (id) {
      renderDetail(S.byId[id]);
      $("#listview").hidden = true; $("#detailview").hidden = false; $("#scroll").scrollTop = 0;
      $("#panel").classList.add("detail-mode");
      if (isPhone() && sheetState === "peek") setSheet("half");
      drawSelection(S.byId[id], opts.fit !== false);
      if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    } else {
      $("#detailview").hidden = true; $("#listview").hidden = false;
      $("#panel").classList.remove("detail-mode");
      $("#scroll").scrollTop = listScroll;
      drawSelection(null);
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    }
  }
  window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id !== (S.selected || "")) select(id || null, { fit: true }); });

  /* ---------------- phone bottom sheet ---------------- */
  const isPhone = () => window.matchMedia("(max-width: 820px)").matches;
  let sheetState = "half";
  const SHEET = { peek: 0.24, half: 0.5, full: 0.92 };
  function sheetPx() { return isPhone() ? $("#panel").getBoundingClientRect().height : 0; }
  function setSheet(st) {
    sheetState = st;
    const panel = $("#panel");
    panel.style.setProperty("--sheet-h", Math.round(SHEET[st] * 100) + "%");
    panel.classList.toggle("collapsed", st === "peek");
    document.documentElement.style.setProperty("--sheet-h-px", Math.round(SHEET[st] * window.innerHeight) + "px");
  }
  (function sheetDrag() {
    const h = $("#handle"), panel = $("#panel");
    let y0 = null, hgt0 = 0, moved = false;
    h.addEventListener("pointerdown", (e) => { y0 = e.clientY; hgt0 = panel.getBoundingClientRect().height; moved = false; panel.classList.add("dragging"); h.setPointerCapture(e.pointerId); });
    h.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      const dy = y0 - e.clientY; if (Math.abs(dy) > 4) moved = true;
      const H = window.innerHeight; const nh = Math.min(H * 0.95, Math.max(H * 0.15, hgt0 + dy));
      panel.style.setProperty("--sheet-h", nh + "px");
    });
    const end = (e) => {
      if (y0 == null) return; panel.classList.remove("dragging");
      const H = window.innerHeight; const frac = panel.getBoundingClientRect().height / H; y0 = null;
      if (!moved) { setSheet(sheetState === "full" ? "half" : sheetState === "half" ? "full" : "half"); return; }
      const best = Object.entries(SHEET).sort((a, b) => Math.abs(a[1] - frac) - Math.abs(b[1] - frac))[0][0];
      setSheet(best);
    };
    h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
  })();

  /* ---------------- misc UI ---------------- */
  let toastTimer;
  function toast(msg) { const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000); }
  function renderLayerMenu() {
    const m = $("#layermenu");
    m.innerHTML = Object.entries(BASES).map(([k, b]) => '<button role="menuitemradio" data-base="' + k + '" aria-checked="' + (S.base === k) + '"' + (k !== "simple" && S.tilesOk === false ? " disabled" : "") + '><span class="dot"></span>' + esc(t(b.key)) + "</button>").join("");
    $("#layerbtn").title = t("layers"); $("#layerbtn").setAttribute("aria-label", t("layers"));
    $("#fitbtn").title = t("fitAll"); $("#fitbtn").setAttribute("aria-label", t("fitAll"));
  }
  $("#layerbtn").addEventListener("click", (e) => { e.stopPropagation(); const m = $("#layermenu"); m.hidden = !m.hidden; $("#layerbtn").setAttribute("aria-expanded", String(!m.hidden)); });
  $("#layermenu").addEventListener("click", (e) => { const b = e.target.closest("[data-base]"); if (b && !b.disabled) { setBase(b.dataset.base); $("#layermenu").hidden = true; } });
  document.addEventListener("click", (e) => { if (!e.target.closest(".mapctl")) $("#layermenu").hidden = true; });
  $("#fitbtn").addEventListener("click", fitAll);

  function renderLang() {
    $("#lang").innerHTML = I.langs.map((l) => '<button data-lang="' + l + '" aria-pressed="' + (l === S.lang) + '" title="' + esc(I.langNames[l]) + '">' + l.toUpperCase() + "</button>").join("");
  }
  $("#lang").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-lang]"); if (!b) return;
    S.lang = b.dataset.lang; store.set("lang", S.lang);
    await loadText(S.lang);
    renderStatic(); refresh();
    if (S.selected) renderDetail(S.byId[S.selected]);
    updatePins(); styleSimpleIfLoaded();
  });
  function styleSimpleIfLoaded() { if (simpleLoaded) { styleSimpleBase(); updatePlaces(); } }
  function renderStatic() {
    document.documentElement.lang = S.lang;
    $("#t-title").textContent = t("title");
    $("#t-tagline").textContent = t("tagline");
    $("#q").placeholder = t("search");
    $("#q").setAttribute("aria-label", t("search"));
    renderLang(); renderLayerMenu();
    $("#foot").innerHTML = "<details><summary>" + esc(t("about")) + "</summary><p>" + esc(t("aboutText")) + "</p></details><p>" + esc(t("mapData")) + "</p>";
  }

  /* re-style canvas layers when the theme flips */
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const restyle = () => { drawTrails(); styleSimpleIfLoaded(); if (S.selected) drawSelection(S.byId[S.selected], false); };
  mq.addEventListener && mq.addEventListener("change", restyle);
  new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------------- boot ---------------- */
  async function boot() {
    renderStatic();
    if (isPhone()) setSheet("half");
    initMap();
    try {
      const idx = await getJSON("data/trails.json");
      S.trails = idx.trails || idx;
    } catch (e) {
      $("#list").innerHTML = '<li class="empty">Could not load trail data.</li>';
      return;
    }
    S.trails.forEach((tr) => { S.byId[tr.id] = tr; });
    await Promise.all([loadText("en"), S.lang !== "en" ? loadText(S.lang) : null]);
    refresh();
    drawTrails();
    const id = location.hash.slice(1);
    if (id && S.byId[id]) select(id, { fit: true }); else fitAll();
  }
  boot();
})();
