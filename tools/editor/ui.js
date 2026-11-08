/* Trail editor UI: trails (left) and the photo archive (right). No framework, no build step. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = async (url, opts) => {
    const r = await fetch(url, opts); const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || r.statusText);
    return d;
  };
  const STAR = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="m8 1.2 2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z"/></svg>';
  const MUNI = { vaasa: "Vaasa", korsholm: "Korsholm", malax: "Malax", laihia: "Laihia", isokyro: "Isokyrö", vora: "Vörå" };

  const S = {
    trails: [], byId: {}, orig: {}, sel: null, filter: "",
    db: null, folder: null, search: "", results: null,
    pics: null, // {set, page, total, pageSize, items}
    lb: null, // {src: "trail"|"browser", i}
    drag: null, saving: false, status: "",
  };
  const app = $("#app");
  app.innerHTML =
    '<header><b>Trail editor</b><span id="dbname"></span><span class="sp"></span><span id="status"></span>' +
    '<button id="save" class="primary" title="Ctrl+S">Save &amp; rebuild</button></header>' +
    '<main><section id="left"><div id="list"></div><div id="trail"></div></section>' +
    '<section id="right"><div id="bhead"></div><div id="browser"></div></section></main>' +
    '<div id="lb" hidden></div>';

  /* ---------------- data ---------------- */
  const snap = (t) => JSON.stringify({ rating: t.rating || null, photos: t.photos || [] });
  const dirtyIds = () => S.trails.filter((t) => snap(t) !== S.orig[t.id]).map((t) => t.id);
  const nameOf = (t) => t.name.local || t.name.fi || t.name.sv || t.id;
  const cur = () => S.byId[S.sel];

  async function loadTrails() {
    const d = await api("/api/trails");
    S.db = d.db;
    S.trails = d.trails.map((t) => ({ ...t, photos: t.photos || [], rating: t.rating || null }));
    S.trails.sort((a, b) => (MUNI[a.municipality] || a.municipality).localeCompare(MUNI[b.municipality] || b.municipality) || nameOf(a).localeCompare(nameOf(b), "fi"));
    S.byId = {}; S.orig = {};
    for (const t of S.trails) { S.byId[t.id] = t; S.orig[t.id] = snap(t); }
    if (!S.byId[S.sel]) S.sel = S.trails[0] && S.trails[0].id;
  }

  /* ---------------- header ---------------- */
  function renderHeader() {
    const n = dirtyIds().length;
    $("#dbname").textContent = S.db ? "Photos: " + S.db : "No photo database (set POHJOISEEN_DB)";
    $("#status").innerHTML = S.status || (n ? '<span class="dirty">' + n + " unsaved trail" + (n > 1 ? "s" : "") + "</span>" : "All saved");
    $("#save").disabled = !n || S.saving;
    document.title = (n ? "● " : "") + "Trail editor";
  }
  async function save() {
    const ids = dirtyIds(); if (!ids.length || S.saving) return;
    const changes = {}; for (const id of ids) changes[id] = { rating: S.byId[id].rating, photos: S.byId[id].photos };
    S.saving = true; S.status = "Saving and rebuilding…"; renderHeader();
    try {
      const r = await api("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
      for (const id of ids) S.orig[id] = snap(S.byId[id]);
      S.status = r.ok ? "Saved " + ids.length + " trail" + (ids.length > 1 ? "s" : "") + ", data rebuilt" : '<span class="err" title="' + esc(r.log) + '">Saved, but the build failed (hover for log)</span>';
      if (!r.ok) console.error(r.log);
    } catch (e) { S.status = '<span class="err">Save failed: ' + esc(e.message) + "</span>"; }
    S.saving = false; renderHeader(); renderList();
    setTimeout(() => { S.status = ""; renderHeader(); }, 6000);
  }
  $("#save").addEventListener("click", save);
  window.addEventListener("beforeunload", (e) => { if (dirtyIds().length) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------------- trail list ---------------- */
  const stars = (n) => { let h = '<span class="stars">'; for (let i = 1; i <= 5; i++) h += '<i class="' + (i <= n ? "on" : "") + '">' + STAR + "</i>"; return h + "</span>"; };
  function renderList() {
    const f = S.filter.toLowerCase();
    let h = '<input id="tfilter" type="search" placeholder="Filter trails…" value="' + esc(S.filter) + '"><ul>';
    let last = null;
    for (const t of S.trails) {
      const hay = [nameOf(t), t.id, t.area, ...(t.aka || [])].join(" ").toLowerCase();
      if (f && !hay.includes(f)) continue;
      if (t.municipality !== last) { last = t.municipality; h += '<li class="grp">' + esc(MUNI[last] || last) + "</li>"; }
      h += '<li class="t' + (t.id === S.sel ? " sel" : "") + '" data-id="' + esc(t.id) + '">' +
        (snap(t) !== S.orig[t.id] ? '<span class="dot" title="Unsaved changes"></span>' : "") +
        '<span class="nm">' + esc(nameOf(t)) + "</span>" +
        '<span class="mt">' + (t.rating ? stars(t.rating) : '<span class="unr">–</span>') + '<span class="pc">' + (t.photos.length ? t.photos.length + " ph" : "") + "</span></span></li>";
    }
    const list = $("#list"); const sc = list.querySelector("ul") ? list.querySelector("ul").scrollTop : 0;
    const focused = document.activeElement && document.activeElement.id === "tfilter";
    list.innerHTML = h + "</ul>";
    list.querySelector("ul").scrollTop = sc;
    if (focused) { const i = $("#tfilter"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  $("#list").addEventListener("input", (e) => { if (e.target.id === "tfilter") { S.filter = e.target.value; renderList(); } });
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("li.t"); if (!li) return;
    S.sel = li.dataset.id; renderList(); renderTrail(); renderBrowserMarks();
  });

  /* ---------------- selected trail ---------------- */
  function renderTrail() {
    const t = cur(); const el = $("#trail");
    if (!t) { el.innerHTML = '<p class="muted">No trail selected.</p>'; return; }
    let h = '<div class="th"><h2>' + esc(nameOf(t)) + '</h2><div class="muted">' + esc([MUNI[t.municipality], t.area].filter(Boolean).join(" · ")) + " · " + esc(t.id) +
      (S.db ? ' <button class="link" id="findsets" title="Search photo folders for this name">find folders</button>' : "") + "</div></div>";
    h += '<div class="rate"><span class="lbl">Rating</span><span class="rstars">';
    for (let i = 1; i <= 5; i++) h += '<button data-rate="' + i + '" class="' + (i <= (t.rating || 0) ? "on" : "") + '" title="' + i + " star" + (i > 1 ? "s" : "") + ' (key ' + i + ')">' + STAR + "</button>";
    h += '</span><button class="small' + (t.rating ? "" : " cur") + '" data-rate="0" title="Key 0">Unrated</button></div>';
    h += '<div class="lbl">Photos <span class="muted">(' + t.photos.length + ") — drag to reorder, drop photos here from the archive</span></div>";
    h += '<div id="tphotos" class="tphotos">' + t.photos.map((p, i) =>
      '<div class="tp" draggable="true" data-i="' + i + '"><img src="' + esc(p.thumb || p.src) + '" alt="" loading="lazy" draggable="false">' +
      '<span class="num">' + (i + 1) + '</span><button class="rm" data-rm="' + i + '" title="Remove">×</button></div>').join("") +
      (t.photos.length ? "" : '<div class="empty">No photos yet. Click photos on the right to add them.</div>') + "</div>";
    el.innerHTML = h;
  }
  function setRating(n) {
    const t = cur(); if (!t) return;
    t.rating = n && n === t.rating ? null : n || null; // clicking the current star again clears
    renderTrail(); renderList(); renderHeader();
  }
  const changed = () => { renderTrail(); renderList(); renderHeader(); renderBrowserMarks(); };
  $("#trail").addEventListener("click", (e) => {
    const r = e.target.closest("[data-rate]"); if (r) return setRating(+r.dataset.rate);
    const rm = e.target.closest("[data-rm]"); if (rm) { cur().photos.splice(+rm.dataset.rm, 1); return changed(); }
    if (e.target.id === "findsets") { S.search = nameOf(cur()); return runSearch(); }
    const tp = e.target.closest(".tp"); if (tp) openLb("trail", +tp.dataset.i);
  });

  /* drag and drop: reorder within the trail, or drop archive photos into it */
  function dropIndex(x, y) {
    const tiles = [...document.querySelectorAll("#tphotos .tp")];
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return tiles.length;
  }
  function markDrop(i) { // insertion marker: before tile i, or after the last tile
    const tiles = document.querySelectorAll("#tphotos .tp");
    tiles.forEach((el, j) => { el.classList.toggle("dropb", j === i); el.classList.toggle("dropa", i === tiles.length && j === i - 1); });
    const box = $("#tphotos"); if (box) box.classList.toggle("over", i != null);
  }
  $("#trail").addEventListener("dragstart", (e) => {
    const tp = e.target.closest(".tp"); if (!tp) return;
    S.drag = { from: +tp.dataset.i }; tp.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "trail-photo");
  });
  $("#trail").addEventListener("dragover", (e) => {
    if (!S.drag || !e.target.closest("#tphotos")) return;
    e.preventDefault(); e.dataTransfer.dropEffect = S.drag.pic ? "copy" : "move";
    markDrop(dropIndex(e.clientX, e.clientY));
  });
  $("#trail").addEventListener("dragleave", (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("#tphotos")) markDrop(null); });
  $("#trail").addEventListener("drop", (e) => {
    if (!S.drag || !e.target.closest("#tphotos")) return;
    e.preventDefault();
    const ps = cur().photos; let to = dropIndex(e.clientX, e.clientY);
    if (S.drag.pic) {
      const p = S.drag.pic; const ex = ps.findIndex((q) => q.id === p.id);
      if (ex >= 0) { ps.splice(ex, 1); if (ex < to) to--; }
      ps.splice(to, 0, toPhoto(p));
    } else {
      const from = S.drag.from; const [p] = ps.splice(from, 1); if (from < to) to--; ps.splice(to, 0, p);
    }
    S.drag = null; changed();
  });
  document.addEventListener("dragend", () => { S.drag = null; markDrop(null); document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging")); });

  /* ---------------- photo archive ---------------- */
  const toPhoto = (p) => ({ id: p.id, thumb: p.thumb, src: p.src, date: p.date || undefined });
  const inTrail = (id) => { const t = cur(); return !!t && t.photos.some((p) => p.id === id); };
  const usedElsewhere = (id) => S.trails.filter((t) => t.id !== S.sel && t.photos.some((p) => p.id === id)).map(nameOf);
  function togglePic(p) {
    const t = cur(); if (!t) return;
    const i = t.photos.findIndex((q) => q.id === p.id);
    if (i >= 0) t.photos.splice(i, 1); else t.photos.push(toPhoto(p));
    changed();
  }

  async function openFolder(parent) {
    S.results = null; S.search = "";
    try { S.folder = await api("/api/sets" + (parent ? "?parent=" + parent : "")); } catch (e) { S.folder = { error: e.message }; }
    S.pics = null;
    if (parent && S.folder.count) await loadPics(parent, 0); else renderBrowser();
    $("#browser").scrollTop = 0;
  }
  async function loadPics(set, page) {
    try { S.pics = { set, ...(await api("/api/pictures?set=" + set + "&page=" + page)) }; } catch (e) { S.pics = { error: e.message }; }
    renderBrowser();
  }
  let searchTimer = null;
  async function runSearch() {
    clearTimeout(searchTimer);
    if (!S.search.trim()) { S.results = null; renderBrowser(); return; }
    try { S.results = (await api("/api/sets?q=" + encodeURIComponent(S.search))).results; } catch (e) { S.results = []; }
    renderBrowser();
  }

  const folderTile = (s, path) => '<button class="folder" data-set="' + s.id + '"><span class="fi">📁</span><span class="fn">' +
    (path ? '<small>' + esc(path) + "</small>" : "") + esc(s.name) + '</span><span class="fc">' +
    [s.subsets ? s.subsets + " folders" : "", s.count ? s.count + " photos" : ""].filter(Boolean).join(", ") + (s.private ? " · private" : "") + "</span></button>";
  function pager() {
    const P = S.pics; const pages = Math.ceil(P.total / P.pageSize); if (pages <= 1) return "";
    let h = '<div class="pager">';
    for (let i = 0; i < pages; i++) h += '<button data-page="' + i + '" class="' + (i === P.page ? "cur" : "") + '">' + (i + 1) + "</button>";
    return h + "</div>";
  }
  function renderBrowser() {
    const head = $("#bhead"), el = $("#browser");
    if (!S.db) { head.innerHTML = ""; el.innerHTML = '<p class="muted pad">No pohjoiseen database found. Put a copy at the repository root (pohjoiseen*.db) or set POHJOISEEN_DB, then restart the editor.</p>'; return; }
    const F = S.folder || { path: [] };
    let hh = '<div class="bar"><input id="fsearch" type="search" placeholder="Search folders by name…" value="' + esc(S.search) + '">' +
      '<span class="target">Adding to: <b>' + esc(cur() ? nameOf(cur()) : "—") + "</b></span></div>";
    if (!S.results) {
      hh += '<nav class="crumbs"><button data-set="">All folders</button>' + F.path.map((p, i) => " › " + (i === F.path.length - 1 ? "<b>" + esc(p.name) + "</b>" : '<button data-set="' + p.id + '">' + esc(p.name) + "</button>")).join("") + "</nav>";
    }
    const focused = document.activeElement && document.activeElement.id === "fsearch";
    head.innerHTML = hh;
    if (focused) { const i = $("#fsearch"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }

    let h = "";
    if (S.results) {
      h += '<div class="folders list">' + (S.results.length ? S.results.map((s) => folderTile(s, s.path)).join("") : '<p class="muted pad">No folders match.</p>') + "</div>";
    } else if (F.error) {
      h += '<p class="err pad">' + esc(F.error) + "</p>";
    } else {
      if (F.sets && F.sets.length) h += '<div class="folders">' + F.sets.map((s) => folderTile(s)).join("") + "</div>";
      if (S.pics && S.pics.error) h += '<p class="err pad">' + esc(S.pics.error) + "</p>";
      else if (S.pics) {
        const P = S.pics;
        h += '<div class="phead">' + P.total + " photos" + (P.total > P.pageSize ? ", " + (P.page * P.pageSize + 1) + "–" + Math.min(P.total, (P.page + 1) * P.pageSize) : "") + '<span class="muted"> · click to add/remove, ⤢ or double-click for full screen, drag into the trail to place</span></div>' + pager();
        h += '<div class="grid">' + P.items.map((p, i) =>
          '<div class="pic" draggable="true" data-i="' + i + '" data-pid="' + p.id + '" title="' + esc([p.title, p.filename, p.date].filter(Boolean).join(" · ")) + '">' +
          '<img src="' + esc(p.thumb) + '" alt="" loading="lazy" draggable="false">' +
          '<button class="zoom" data-zoom="' + i + '" title="Full screen">⤢</button><span class="chk">✓</span><span class="else"></span>' +
          (p.private ? '<span class="priv">private</span>' : "") + "</div>").join("") + "</div>" + pager();
      }
    }
    el.innerHTML = h;
    renderBrowserMarks();
  }
  function renderBrowserMarks() {
    document.querySelectorAll("#browser .pic").forEach((el) => {
      const id = +el.dataset.pid; el.classList.toggle("in", inTrail(id));
      const o = usedElsewhere(id); const b = $(".else", el);
      b.textContent = o.length ? "also: " + o.join(", ") : ""; b.hidden = !o.length;
    });
    const tg = $("#bhead .target b"); if (tg) tg.textContent = cur() ? nameOf(cur()) : "—";
  }
  $("#bhead").addEventListener("input", (e) => {
    if (e.target.id !== "fsearch") return;
    S.search = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200);
  });
  $("#bhead").addEventListener("click", (e) => { const b = e.target.closest("[data-set]"); if (b) openFolder(b.dataset.set ? +b.dataset.set : null); });
  $("#browser").addEventListener("click", (e) => {
    const f = e.target.closest(".folder"); if (f) return openFolder(+f.dataset.set);
    const pg = e.target.closest("[data-page]"); if (pg) { loadPics(S.pics.set, +pg.dataset.page); $("#browser").scrollTop = 0; return; }
    const z = e.target.closest("[data-zoom]"); if (z) return openLb("browser", +z.dataset.zoom);
    const p = e.target.closest(".pic"); if (p && e.detail === 1) togglePic(S.pics.items[+p.dataset.i]);
  });
  $("#browser").addEventListener("dblclick", (e) => {
    const p = e.target.closest(".pic"); if (!p) return;
    togglePic(S.pics.items[+p.dataset.i]); // undo the single click's toggle
    openLb("browser", +p.dataset.i);
  });
  $("#browser").addEventListener("dragstart", (e) => {
    const p = e.target.closest(".pic"); if (!p) return;
    S.drag = { pic: S.pics.items[+p.dataset.i] };
    e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("text/plain", "archive-photo");
  });

  /* ---------------- full screen ---------------- */
  const lbItems = () => (S.lb.src === "trail" ? cur().photos : S.pics.items);
  function openLb(src, i) { S.lb = { src, i }; $("#lb").hidden = false; renderLb(); }
  function closeLb() { S.lb = null; $("#lb").hidden = true; $("#lb").innerHTML = ""; }
  function renderLb() {
    const items = lbItems(); const p = items[S.lb.i]; if (!p) return closeLb();
    const br = S.lb.src === "browser"; const P = S.pics;
    const pos = br ? P.page * P.pageSize + S.lb.i + 1 : S.lb.i + 1; const total = br ? P.total : items.length;
    const added = inTrail(p.id);
    const el = $("#lb");
    el.innerHTML = '<img class="full" src="' + esc(p.thumb || p.src) + '" alt="">' +
      '<div class="lbbar"><span>' + pos + " / " + total + (p.date ? " · " + esc(p.date) : "") + (p.filename ? " · " + esc(p.filename) : "") + (p.title ? " · " + esc(p.title) : "") + "</span>" +
      (br ? '<button id="lbadd" class="' + (added ? "" : "primary") + '">' + (added ? "✓ In " + esc(nameOf(cur())) + " — remove" : "Add to " + esc(nameOf(cur()))) + "</button><span class=\"muted\">Space: add/remove</span>"
        : '<button id="lbrm">Remove from trail</button>') +
      '<a href="' + esc(p.src) + '" target="_blank" rel="noopener">original</a></div>' +
      '<button class="nav pv" title="←">‹</button><button class="nav nx" title="→">›</button><button class="nav x" title="Esc">×</button>';
    // thumbnail first (cached), then the full-size image; preload the neighbours
    const full = new Image(); const want = p;
    full.onload = () => { if (S.lb && lbItems()[S.lb.i] === want) { const im = $("img.full", el); if (im) im.src = want.src; } };
    full.src = p.src;
    for (const d of [1, -1]) { const q = items[S.lb.i + d]; if (q) new Image().src = q.src; }
  }
  async function lbMove(d) {
    const items = lbItems(); let i = S.lb.i + d;
    if (S.lb.src === "browser" && (i < 0 || i >= items.length)) {
      const P = S.pics, pages = Math.ceil(P.total / P.pageSize);
      const np = (P.page + (i < 0 ? -1 : 1) + pages) % pages;
      if (np !== P.page) { await loadPics(P.set, np); i = i < 0 ? S.pics.items.length - 1 : 0; S.lb.i = i; return renderLb(); }
    }
    S.lb.i = (i + items.length) % items.length; renderLb();
  }
  $("#lb").addEventListener("click", (e) => {
    if (e.target.closest(".x") || e.target.id === "lb") return closeLb();
    if (e.target.closest(".pv")) return lbMove(-1);
    if (e.target.closest(".nx")) return lbMove(1);
    if (e.target.id === "lbadd") { togglePic(lbItems()[S.lb.i]); return renderLb(); }
    if (e.target.id === "lbrm") { cur().photos.splice(S.lb.i, 1); changed(); if (!cur().photos.length) return closeLb(); S.lb.i = Math.min(S.lb.i, cur().photos.length - 1); return renderLb(); }
  });

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); return; }
    if (S.lb) {
      if (e.key === "Escape") closeLb();
      else if (e.key === "ArrowLeft") lbMove(-1);
      else if (e.key === "ArrowRight") lbMove(1);
      else if ((e.key === " " || e.key === "Enter") && S.lb.src === "browser") { e.preventDefault(); togglePic(lbItems()[S.lb.i]); renderLb(); }
      return;
    }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-5]$/.test(e.key)) setRating(+e.key);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const vis = [...document.querySelectorAll("#list li.t")]; const i = vis.findIndex((li) => li.dataset.id === S.sel);
      const n = vis[i + (e.key === "ArrowDown" ? 1 : -1)]; if (!n) return;
      e.preventDefault(); S.sel = n.dataset.id; renderList(); renderTrail(); renderBrowserMarks();
      const li = $('#list li[data-id="' + CSS.escape(S.sel) + '"]'); if (li) li.scrollIntoView({ block: "nearest" });
    }
  });

  /* ---------------- start ---------------- */
  (async () => {
    try { await loadTrails(); } catch (e) { app.innerHTML = '<p class="err pad">Could not load trails: ' + esc(e.message) + "</p>"; return; }
    renderHeader(); renderList(); renderTrail();
    if (S.db) await openFolder(null); else renderBrowser();
  })();
})();
