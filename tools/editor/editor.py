#!/usr/bin/env python3
"""Local editor for trail ratings and photos.

    python3 tools/editor/editor.py            # then open http://127.0.0.1:8765/
    POHJOISEEN_DB=/path/to/pohjoiseen.db PORT=8800 python3 tools/editor/editor.py

Left pane: trails from data-src/trails.json (rating, photos). Right pane: the photo archive from a copy of
the pohjoiseen blog database (read-only), browsed by PictureSets. "Save" writes data-src/trails.json and runs
tools/build_data.py.

The database path comes from $POHJOISEEN_DB; without it, the newest pohjoiseen*.db in the repository root is used.
Without a database the editor still works for ratings and for reordering/removing photos.

Only for local use: it listens on 127.0.0.1 and has no authentication. The UI is served from this script
(there is deliberately no .html file here, so GitHub Pages has no page to show for it).
"""
import glob, json, os, sqlite3, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TRAILS = os.path.join(ROOT, "data-src", "trails.json")
BUILD = os.path.join(ROOT, "tools", "build_data.py")
PAGE_SIZE = 100
save_lock = threading.Lock()


def find_db():
    p = os.environ.get("POHJOISEEN_DB")
    if p:
        if not os.path.isfile(p):
            sys.exit("POHJOISEEN_DB does not exist: " + p)
        return p
    found = sorted(glob.glob(os.path.join(ROOT, "pohjoiseen*.db")), key=os.path.getmtime)
    return found[-1] if found else None


DB = find_db()


def db():
    con = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


class Archive:
    """Picture sets are few (hundreds), so keep the tree and per-set counts in memory."""

    def __init__(self):
        with db() as con:
            self.sets = {r["Id"]: {"id": r["Id"], "name": r["Name"], "parent": r["ParentId"], "private": bool(r["IsPrivate"])}
                         for r in con.execute("SELECT Id, Name, ParentId, IsPrivate FROM PictureSets")}
            counts = dict(con.execute("SELECT SetId, COUNT(*) FROM Pictures GROUP BY SetId").fetchall())
        self.children = {}
        for s in self.sets.values():
            s["count"] = counts.get(s["id"], 0)
            self.children.setdefault(s["parent"], []).append(s["id"])
        for s in self.sets.values():
            s["subsets"] = len(self.children.get(s["id"], []))

    def path(self, sid):
        out = []
        while sid is not None and sid in self.sets:
            out.append({"id": sid, "name": self.sets[sid]["name"]})
            sid = self.sets[sid]["parent"]
        return out[::-1]

    def brief(self, sid, with_path=False):
        s = self.sets[sid]
        d = {k: s[k] for k in ("id", "name", "private", "count", "subsets")}
        if with_path:
            d["path"] = " › ".join(p["name"] for p in self.path(s["parent"]))
        return d

    def folder(self, sid):
        kids = sorted(self.children.get(sid, []), key=lambda i: self.sets[i]["name"], reverse=sid is None)
        return {"path": self.path(sid), "sets": [self.brief(i) for i in kids], "count": self.sets[sid]["count"] if sid else 0}

    def search(self, q):
        words = q.casefold().split()
        hits = [i for i, s in self.sets.items() if all(w in s["name"].casefold() for w in words)]
        hits.sort(key=lambda i: self.sets[i]["name"], reverse=True)
        return {"results": [self.brief(i, True) for i in hits[:200]]}

    @staticmethod
    def pictures(sid, page):
        with db() as con:
            total = con.execute("SELECT COUNT(*) FROM Pictures WHERE SetId = ?", (sid,)).fetchone()[0]
            rows = con.execute(
                "SELECT Id, Title, Description, Filename, Url, ThumbnailUrl, DetailsUrl, Width, Height, IsPrivate, PhotographedAt "
                "FROM Pictures WHERE SetId = ? ORDER BY PhotographedAt IS NULL, PhotographedAt, Filename, Id LIMIT ? OFFSET ?",
                (sid, PAGE_SIZE, page * PAGE_SIZE)).fetchall()
        items = [{
            "id": r["Id"], "title": r["Title"], "description": r["Description"], "filename": r["Filename"],
            "src": r["Url"], "thumb": r["ThumbnailUrl"] or r["Url"], "w": r["Width"], "h": r["Height"],
            "private": bool(r["IsPrivate"]), "date": (r["PhotographedAt"] or "")[:10] or None,
        } for r in rows]
        return {"total": total, "page": page, "pageSize": PAGE_SIZE, "items": items}


archive = Archive() if DB else None


def load_trails():
    with open(TRAILS, encoding="utf-8") as f:
        return json.load(f)


def clean_photo(p):
    if not isinstance(p, dict) or not isinstance(p.get("src"), str):
        raise ValueError("bad photo entry: %r" % (p,))
    out = {k: p[k] for k in ("id", "thumb", "src", "date", "caption") if p.get(k) not in (None, "")}
    return out


def save(changes):
    """changes: {trail_id: {"rating": null|1..5, "photos": [...]}}. Only those two fields are touched."""
    with save_lock:
        trails = load_trails()
        by_id = {t["id"]: t for t in trails}
        for tid, ch in changes.items():
            if tid not in by_id:
                raise ValueError("unknown trail: " + tid)
            r = ch.get("rating")
            if r is not None and (not isinstance(r, int) or not 1 <= r <= 5):
                raise ValueError("bad rating for %s: %r" % (tid, r))
            by_id[tid]["rating"] = r
            by_id[tid]["photos"] = [clean_photo(p) for p in ch.get("photos", [])]
        tmp = TRAILS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(trails, f, ensure_ascii=False, indent=1)  # same layout as the existing file
        os.replace(tmp, TRAILS)
        res = subprocess.run([sys.executable, BUILD], cwd=ROOT, capture_output=True, text=True)
        return {"ok": res.returncode == 0, "saved": len(changes), "log": (res.stdout + res.stderr)[-4000:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the console quiet apart from saves and errors
        line = fmt % args
        if "/api/save" in line or '" 4' in line or '" 5' in line:
            super().log_message(fmt, *args)

    def send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def json(self, obj, code=200):
        self.send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def static(self, name, ctype):
        with open(os.path.join(HERE, name), "rb") as f:
            self.send(200, f.read(), ctype)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/":
                self.send(200, PAGE, "text/html; charset=utf-8")
            elif u.path == "/ui.js":
                self.static("ui.js", "text/javascript; charset=utf-8")
            elif u.path == "/ui.css":
                self.static("ui.css", "text/css; charset=utf-8")
            elif u.path == "/favicon.png":
                self.static(os.path.join(ROOT, "favicon.png"), "image/png")
            elif u.path == "/api/trails":
                self.json({"trails": load_trails(), "db": os.path.basename(DB) if DB else None})
            elif u.path == "/api/sets":
                if not archive:
                    return self.json({"error": "no database"}, 404)
                if q.get("q", "").strip():
                    return self.json(archive.search(q["q"]))
                sid = int(q["parent"]) if q.get("parent") else None
                if sid is not None and sid not in archive.sets:
                    return self.json({"error": "no such folder"}, 404)
                self.json(archive.folder(sid))
            elif u.path == "/api/pictures":
                if not archive:
                    return self.json({"error": "no database"}, 404)
                self.json(archive.pictures(int(q["set"]), max(0, int(q.get("page", 0)))))
            else:
                self.send(404, "not found", "text/plain")
        except Exception as e:  # report to the UI rather than dropping the connection
            self.json({"error": str(e)}, 500)

    def do_POST(self):
        if urlparse(self.path).path != "/api/save":
            return self.send(404, "not found", "text/plain")
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            self.json(save(body.get("changes", {})))
        except Exception as e:
            self.json({"ok": False, "error": str(e)}, 400)


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail editor</title><link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/ui.css"></head>
<body><div id="app"></div><script src="/ui.js"></script></body></html>"""


def main():
    port = int(os.environ.get("PORT", "8765"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Photo database:", DB or "none found (set POHJOISEEN_DB); photo browser disabled")
    print("Trail editor: http://127.0.0.1:%d/  (Ctrl+C to stop)" % port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
