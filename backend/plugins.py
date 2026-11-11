"""The plugin host. Plugins live in %APPDATA%\\Wavelog\\plugins\\<id>\\ (plugin.json + main.py, see wavelog.py) and run
inside the logger. Each one loads on its own: one that fails to load is turned off with its error shown in Settings >
Plugins, and an error in a job or a page never takes the logger down.

Their on/off state and settings are in plugins.json, not settings.json, so saving Wavelog's own settings can't
overwrite them. Each plugin gets its own data folder, plugin-data\\<id>\\, which stays when the plugin is removed.

Developer mode: a folder added with "Load a folder" runs from where it is (nothing is copied) and reloads by itself
when a file in it changes.
"""
import asyncio
import hashlib
import importlib.util
import inspect
import json
import logging
import re
import shutil
import sqlite3
import sys
import time
import uuid
import zipfile
from collections import deque
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

import poller
import wavelog
from db import DATA, db, ts
from version import VERSION

log = logging.getLogger("plugins")
router = APIRouter()
ROOT = DATA / "plugins"
STORE = DATA / "plugin-data"
TMP = DATA / "plugin-tmp"
STATE = DATA / "plugins.json"
ROOT.mkdir(exist_ok=True)
ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
TYPES = {"switch", "text", "number", "slider", "choice"}
IMAGES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
          ".svg": "image/svg+xml", ".ico": "image/x-icon"}
http = httpx.AsyncClient(timeout=30, follow_redirects=True, headers={"User-Agent": "Wavelog plugin (local app)"})
state = json.loads(STATE.read_text("utf-8")) if STATE.exists() else {}
loaded = {}  # id -> Loaded
alerts = deque(maxlen=50)
alert_ids = iter(range(1, 1 << 62))
watcher = None


def save_state():
    STATE.write_text(json.dumps(state, indent=1), "utf-8")


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:3]) or (0,)


def read_manifest(folder):
    f = Path(folder) / "plugin.json"
    if not f.exists():
        raise ValueError("No plugin.json in it")
    try:
        m = json.loads(f.read_text("utf-8"))
    except ValueError as e:
        raise ValueError(f"plugin.json isn't valid JSON: {e}")
    if not isinstance(m.get("id"), str) or not ID.match(m["id"]):
        raise ValueError("plugin.json needs an id: 2 to 32 lowercase letters, numbers or dashes")
    if not isinstance(m.get("name"), str) or not m["name"].strip():
        raise ValueError("plugin.json needs a name")
    if m.get("api", 1) != wavelog.API:
        raise ValueError(f"Made for plugin API {m.get('api')}, this Wavelog has API {wavelog.API}")
    if version_tuple(m.get("min_app", "0")) > version_tuple(VERSION):
        raise ValueError(f"Needs Wavelog {m['min_app']} or newer")
    if not (Path(folder) / m.get("main", "main.py")).exists():
        raise ValueError(f"{m.get('main', 'main.py')} is missing")
    for s in m.get("settings") or []:
        if not isinstance(s, dict) or not s.get("key") or s.get("type") not in TYPES:
            raise ValueError(f"A setting in plugin.json needs a key and a type ({', '.join(sorted(TYPES))})")
    return m


class Ctx:
    """What a plugin's handlers get as `ctx`."""

    def __init__(self, pl):
        self._pl = pl
        self.id = pl.id
        self.name = pl.manifest["name"]
        self.dir = pl.dir
        self.data = STORE / pl.id
        self.data.mkdir(parents=True, exist_ok=True)
        self.log = logging.getLogger(f"plugin.{pl.id}")
        self.http = http
        self._db = None
        self._store = None

    @property
    def settings(self):
        """The plugin's settings from plugin.json, with what the user picked."""
        return values(self._pl)

    def set(self, key, value):
        """Save one setting (or any value the plugin wants to keep there, like a wishlist)."""
        state.setdefault(self.id, {}).setdefault("values", {})[key] = value
        save_state()

    @property
    def store(self):
        """A dict saved as store.json in the plugin's data folder. Call ctx.save() after changing it."""
        if self._store is None:
            f = self.data / "store.json"
            self._store = json.loads(f.read_text("utf-8")) if f.exists() else {}
        return self._store

    def save(self):
        (self.data / "store.json").write_text(json.dumps(self._store or {}), "utf-8")

    @property
    def db(self):
        """The plugin's own SQLite database (data.db in its data folder), autocommit."""
        if self._db is None:
            self._db = sqlite3.connect(self.data / "data.db", check_same_thread=False, isolation_level=None, timeout=30)
            self._db.row_factory = sqlite3.Row
        return self._db

    def alert(self, text, sub=None, icon=None, color=None, short=None):
        """A notch alert, e.g. ctx.alert("Win 13-9 · Ascent", "+21 RR", icon_url, color="#30d158"). It shows for 20
        seconds. `short` is what the small pill shows (defaults to the start of `sub`)."""
        alerts.append({"id": next(alert_ids), "plugin": self.id, "at": time.time(), "text": str(text), "sub": sub and str(sub),
                       "icon": image(self._pl, icon), "color": color, "short": short and str(short)})

    def now(self):
        """What Spotify plays right now, or None."""
        c = poller.cur
        if not c:
            return None
        t = c["track"]
        return {"id": t["id"], "name": t["name"], "artists": ", ".join(a["name"] for a in t["artists"]), "album": t["album"]["name"],
                "image": (t["album"].get("images") or [{}])[0].get("url"), "playing": c["playing"], "duration_ms": t["duration_ms"],
                "progress_ms": int(c["progress"] + ((time.time() - c["poll"]) * 1000 if c["playing"] else 0))}

    def plays(self, start, end):
        """Spotify plays that ended between two Unix times, oldest first."""
        from api import ARTISTS, q
        return q(f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image, unixepoch(p.played_at) AS ended, "
                 "p.ms_played AS ms FROM plays p JOIN tracks t ON t.id = p.track_id LEFT JOIN albums al ON al.id = t.album_id "
                 "WHERE p.played_at >= ? AND p.played_at < ? ORDER BY p.played_at", ts(start), ts(end))

    def game(self):
        """The fullscreen game in front: {"exe", "title"}, or None."""
        import games
        g = games.game()
        return {"exe": g[0], "title": g[1]} if g else None

    def close(self):
        if self._db:
            self._db.close()
            self._db = None


class Loaded:
    def __init__(self, folder, manifest, dev):
        self.id, self.dir, self.manifest, self.dev = manifest["id"], Path(folder), manifest, dev
        self.plugin = self.module = self.ctx = None
        self.error = None      # why it couldn't load
        self.last_error = None  # last error from a page, widget or action
        self.tasks = []
        self.stamp = stamp(folder)

    @property
    def enabled(self):
        return state.get(self.id, {}).get("enabled", True)


def stamp(folder):
    """Changes when any file of the plugin does (for developer mode)."""
    try:
        return max((f.stat().st_mtime for f in Path(folder).rglob("*") if f.is_file() and "__pycache__" not in f.parts), default=0)
    except OSError:
        return 0


def values(pl):
    saved = state.get(pl.id, {}).get("values", {})
    out = {s["key"]: s.get("default") for s in pl.manifest.get("settings") or []}
    return {**out, **saved}


def modname(pid):
    return "wavelog_plugin_" + pid.replace("-", "_")


def load(pl):
    """Import the plugin's main.py and start it if it's on."""
    name = modname(pl.id)
    for k in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
        del sys.modules[k]
    lib = pl.dir / "lib"
    if lib.is_dir() and str(lib) not in sys.path:
        sys.path.append(str(lib))
    try:
        spec = importlib.util.spec_from_file_location(name, pl.dir / pl.manifest.get("main", "main.py"), submodule_search_locations=[str(pl.dir)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        p = next((v for v in vars(mod).values() if isinstance(v, wavelog.Plugin)), None)
        if not p:
            raise ValueError("main.py doesn't make a Plugin()")
        pl.module, pl.plugin, pl.ctx, pl.error = mod, p, Ctx(pl), None
        if pl.id in MIGRATIONS and not (pl.ctx.data / ".migrated").exists():
            MIGRATIONS[pl.id](pl)
            (pl.ctx.data / ".migrated").write_text(time.strftime("%Y-%m-%d %H:%M"))
    except Exception as e:
        log.exception("Plugin %s failed to load", pl.id)
        pl.error = f"{type(e).__name__}: {e}"[:400]
        pl.plugin = None
        return
    if pl.enabled:
        start(pl)


def start(pl):
    if not pl.plugin or pl.tasks:
        return
    for fn, every, wait in pl.plugin.jobs:
        pl.tasks.append(asyncio.create_task(run_job(pl, fn, every, wait)))
    if h := pl.plugin.hooks.get("start"):
        pl.tasks.append(asyncio.create_task(safe(pl, h)))
    log.info("Plugin %s started", pl.id)


async def run_job(pl, fn, every, wait):
    await asyncio.sleep(wait)

    async def job():
        await call(pl, fn)
    job.__module__, job.__name__ = f"plugin:{pl.manifest['name']}", fn.__name__
    await poller.loop(job, (lambda: every(pl.ctx)) if callable(every) else every)


async def stop(pl):
    for t in pl.tasks:
        t.cancel()
    pl.tasks = []
    if pl.plugin and (h := pl.plugin.hooks.get("stop")):
        await safe(pl, h)
    if pl.ctx:
        pl.ctx.close()


async def call(pl, fn, **kw):
    """Run a handler with ctx and the arguments it asks for. Plain functions run on a worker thread."""
    params = inspect.signature(fn).parameters
    if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
        kw = {k: v for k, v in kw.items() if k in params}
    if inspect.iscoroutinefunction(fn):
        return await fn(pl.ctx, **kw)
    r = await asyncio.to_thread(fn, pl.ctx, **kw)
    return await r if inspect.isawaitable(r) else r


async def safe(pl, fn, **kw):
    try:
        return await call(pl, fn, **kw)
    except Exception as e:
        log.exception("Plugin %s: %s failed", pl.id, getattr(fn, "__name__", fn))
        pl.last_error = f"{type(e).__name__}: {e}"[:400]


def image(pl, v):
    """Images from plugins: web links go through /p/<id>/img (cached, keeps the app's security policy tight),
    other names are files in the plugin folder."""
    if not isinstance(v, str) or not v or v.startswith(("data:", "/p/")):
        return v
    if v.startswith(("https://", "http://")):
        return f"/p/{pl.id}/img?u={quote(v, safe='')}"
    return f"/p/{pl.id}/file/{quote(v)}"


def clean(pl, x):
    if isinstance(x, dict):
        return {k: image(pl, v) if k in ("image", "icon") else clean(pl, v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(pl, v) for v in x if v is not None and v is not False]
    return x


async def blocks(pl, fn, **kw):
    try:
        out = await call(pl, fn, **kw)
    except Exception as e:
        log.exception("Plugin %s: %s failed", pl.id, fn.__name__)
        pl.last_error = f"{type(e).__name__}: {e}"[:400]
        return [{"type": "error", "text": pl.last_error}]
    out = [out] if isinstance(out, dict) else out or []
    return json.loads(json.dumps(clean(pl, out), default=str))


def migrate_valorant(pl):
    """Valorant was built in before 0.10.0: copy its match history, wishlist and settings into the plugin, once.
    The old copies stay where they are (nothing is deleted)."""
    from widgets import settings
    ctx = pl.ctx
    row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='val_matches'").fetchone()
    if row:
        ctx.db.execute(row[0].replace("CREATE TABLE val_matches", "CREATE TABLE IF NOT EXISTS val_matches"))
        ctx.db.execute("ATTACH DATABASE ? AS core", (str(DATA / "spotify.db"),))
        try:
            ctx.db.execute("INSERT OR IGNORE INTO val_matches SELECT * FROM core.val_matches")
        finally:
            ctx.db.execute("DETACH DATABASE core")
    for name, dest in (("valorant.json", "account.json"), ("valorant-store.json", "shop.json")):
        if (DATA / name).exists() and not (ctx.data / dest).exists():
            shutil.copyfile(DATA / name, ctx.data / dest)
    if settings.get("val_wishlist"):
        ctx.store.setdefault("wishlist", settings["val_wishlist"])
        ctx.save()
    if settings.get("tab_y") is not None:
        state.setdefault(pl.id, {}).setdefault("values", {}).setdefault("tab_y", settings["tab_y"])
    if (settings.get("notch") or {}).get("duck_valorant") is False:
        state.setdefault(pl.id, {}).setdefault("duck", False)
    save_state()
    log.info("Copied Valorant into its plugin (%s)", "with match history" if row else "no match history")


MIGRATIONS = {"valorant": migrate_valorant}


def bundled(pid):
    """Plugins that ship inside Wavelog (only for moving built-in features out). Frozen: in the exe; from source:
    the wavelog-plugins folder next to the app."""
    base = Path(getattr(sys, "_MEIPASS", "")) / "bundled" if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2] / "wavelog-plugins"
    folder = base / pid
    return folder if (folder / "plugin.json").exists() else None


def adopt_valorant():
    """0.10.0 took Valorant out of the app. Anyone who had the tracker on gets the plugin, once, with their Valorant
    widget, notch section and Over games kept, and a notice in the stats window."""
    from widgets import FILE, settings
    if state.get("_moved_valorant"):
        return
    if settings.get("valorant") and not (ROOT / "valorant").exists():
        src = bundled("valorant")
        if not src:
            log.warning("The Valorant plugin isn't in this build, so Valorant wasn't moved. Trying again next start")
            return
        shutil.copytree(src, ROOT / "valorant", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"))
        state.setdefault("valorant", {})["enabled"] = True
        state["_notice"] = {"id": "valorant", "title": "Valorant is a plugin now",
                            "text": "Same stats, store and Tab panel. Settings → Plugins"}
        swap = {"valorant": "p_valorant_rank"}
        settings["widgets"] = [swap.get(w, w) for w in settings.get("widgets", [])]
        settings["overlay"] = [swap.get(w, w) for w in settings.get("overlay", [])]
        settings["stack"] = [w for w in settings.get("stack", []) if w != "valorant"]
        if "valorant" in (settings.get("sizes") or {}):
            settings["sizes"]["p_valorant_rank"] = settings["sizes"].pop("valorant")
        n = settings.get("notch") or {}
        if n.get("sections"):
            n["sections"] = ["p_valorant_last_match" if s == "valorant" else s for s in n["sections"]]
        FILE.write_text(json.dumps(settings, indent=2))
        log.info("Valorant moved into its plugin")
    state["_moved_valorant"] = True
    save_state()


@router.post("/plugins/notice/dismiss")
async def dismiss_notice():
    state.pop("_notice", None)
    save_state()
    return {"ok": True}


def discover():
    """Installed plugins plus developer folders (a developer folder wins over an installed copy with the same id)."""
    found, errors = {}, []
    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        try:
            m = read_manifest(folder)
            found[m["id"]] = (folder, m, False)
        except Exception as e:
            errors.append((folder, e))
    for path in state.get("_dev", []):
        try:
            m = read_manifest(path)
            found[m["id"]] = (Path(path), m, True)
        except Exception as e:
            errors.append((Path(path), e))
    for folder, e in errors:
        log.warning("Skipped plugin folder %s: %s", folder, e)
    return found, errors


async def start_all():
    global watcher
    try:
        adopt_valorant()
    except Exception:
        log.exception("Moving Valorant into its plugin failed")
    found, _ = discover()
    for folder, m, dev in found.values():
        pl = loaded[m["id"]] = Loaded(folder, m, dev)
        load(pl)
    watcher = asyncio.create_task(watch())


async def stop_all():
    if watcher:
        watcher.cancel()
    for pl in list(loaded.values()):
        await stop(pl)


async def reload(pid):
    pl = loaded.get(pid)
    folder, dev = (pl.dir, pl.dev) if pl else (ROOT / pid, False)
    if pl:
        await stop(pl)
    try:
        m = read_manifest(folder)
    except Exception as e:
        if pl:
            pl.error, pl.plugin, pl.stamp = str(e), None, stamp(folder)
        return
    pl = loaded[pid] = Loaded(folder, m, dev)
    load(pl)


async def watch():
    """Developer mode: reload a developer folder when one of its files changes."""
    while True:
        await asyncio.sleep(1.5)
        for pl in [p for p in loaded.values() if p.dev]:
            s = stamp(pl.dir)
            if s != pl.stamp:
                log.info("Plugin %s changed, reloading", pl.id)
                await reload(pl.id)


def find(pid):
    pl = loaded.get(pid)
    if not pl:
        raise HTTPException(404, "No such plugin")
    return pl


def running(pid):
    pl = find(pid)
    if not pl.plugin or not pl.enabled:
        raise HTTPException(409, "The plugin is off")
    return pl


def uses(m):
    """What the plugin says it uses, as short lines for the install screen. Information, not enforcement."""
    u = m.get("uses") or {}
    out = []
    if u.get("network"):
        out.append("Connects to " + ", ".join(u["network"]))
    if u.get("files"):
        out.append("Reads files in " + ", ".join(u["files"]))
    if u.get("plays"):
        out.append("Reads your Spotify plays")
    if u.get("games"):
        out.append("Sees which game is in front")
    if u.get("overlay"):
        out.append("Shows a panel over a game")
    if u.get("ducking"):
        out.append("Can lower Spotify's volume")
    return out


def info(pl):
    m, p = pl.manifest, pl.plugin
    return {
        "id": pl.id, "name": m["name"], "version": m.get("version", ""), "author": m.get("author", ""),
        "description": m.get("description", ""), "icon": image(pl, m.get("icon")), "homepage": m.get("homepage", ""),
        "enabled": pl.enabled, "dev": pl.dev, "path": str(pl.dir), "error": pl.error, "last_error": pl.last_error,
        "uses": uses(m), "settings": m.get("settings") or [], "values": values(pl),
        "pages": [{"id": k, "title": t, "ranges": r, "choices": c} for k, (_, t, r, c) in p.pages.items()] if p else [],
        "widgets": [{"id": k, "title": t, "sizes": s} for k, (_, t, s) in p.widgets.items()] if p else [],
        "sections": [{"id": k, "title": t} for k, (_, t) in p.sections.items()] if p else [],
        "jobs": [fn.__name__ for fn, _, _ in p.jobs] if p else [],
        "overlays": [{"id": fn.__name__, "game": g, "key": k, "w": w, "h": h, "y": float(values(pl).get(y, 0.7) if isinstance(y, str) else y)}
                     for fn, g, k, w, h, y in p.overlays] if p else [],
        "ducks": bool(p and p.ducks), "duck": state.get(pl.id, {}).get("duck", True),
    }


# --- Installing ----------------------------------------------------------------------------------------------------
def unpack(path):
    """A plugin folder, or a .zip extracted into a temporary folder. Returns (folder, temporary or not)."""
    src = Path(str(path).strip().strip('"'))
    if src.is_dir():
        return src, False
    if src.suffix.lower() != ".zip" or not src.is_file():
        raise ValueError("Pick a plugin folder or a .zip")
    out = TMP / uuid.uuid4().hex
    out.mkdir(parents=True)
    with zipfile.ZipFile(src) as z:
        for member in z.infolist():
            target = (out / member.filename).resolve()
            if not target.is_relative_to(out.resolve()):
                raise ValueError("The zip has files outside its folder")
        z.extractall(out)
    inner = [p for p in out.iterdir()]
    if not (out / "plugin.json").exists() and len(inner) == 1 and inner[0].is_dir():
        return inner[0], True
    return out, True


def cleanup():
    shutil.rmtree(TMP, ignore_errors=True)


@router.post("/plugins/inspect")
async def inspect_plugin(body: dict = Body(...)):
    """Read a plugin before installing it, for the install screen."""
    try:
        folder, _ = unpack(body.get("path", ""))
        m = read_manifest(folder)
    except Exception as e:
        raise HTTPException(400, str(e))
    finally:
        cleanup()
    have = loaded.get(m["id"])
    return {"id": m["id"], "name": m["name"], "version": m.get("version", ""), "author": m.get("author", ""),
            "description": m.get("description", ""), "uses": uses(m),
            "installed": have.manifest.get("version") if have and not have.dev else None}


@router.post("/plugins/install")
async def install(body: dict = Body(...)):
    try:
        folder, _ = unpack(body.get("path", ""))
        m = read_manifest(folder)
        pid, dest, tmp = m["id"], ROOT / m["id"], ROOT / f".{m['id']}-new"
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(folder, tmp, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"))
    except Exception as e:
        cleanup()
        raise HTTPException(400, str(e))
    cleanup()
    if pl := loaded.get(pid):
        await stop(pl)
    shutil.rmtree(dest, ignore_errors=True)
    tmp.rename(dest)
    state.setdefault(pid, {})["enabled"] = True
    save_state()
    await reload(pid)
    log.info("Installed plugin %s %s", pid, m.get("version", ""))
    return info(loaded[pid])


@router.post("/plugins/dev")
async def add_dev(body: dict = Body(...)):
    """Developer mode: run a plugin from its folder and reload it on every change."""
    path = str(Path(str(body.get("path", "")).strip().strip('"')))
    try:
        m = read_manifest(path)
    except Exception as e:
        raise HTTPException(400, str(e))
    dev = [p for p in state.get("_dev", []) if p != path]
    for p in dev[:]:
        try:
            if read_manifest(p)["id"] == m["id"]:
                dev.remove(p)
        except Exception:
            pass
    state["_dev"] = dev + [path]
    state.setdefault(m["id"], {})["enabled"] = True
    save_state()
    if pl := loaded.get(m["id"]):
        await stop(pl)
    pl = loaded[m["id"]] = Loaded(path, m, True)
    load(pl)
    return info(pl)


@router.delete("/plugins/{pid}")
async def remove(pid: str):
    """Remove a plugin. A developer folder is only unlinked; its files stay. The data folder always stays."""
    pl = find(pid)
    await stop(pl)
    if pl.dev:
        state["_dev"] = [p for p in state.get("_dev", []) if Path(p) != pl.dir]
    else:
        shutil.rmtree(pl.dir, ignore_errors=True)
    state.pop(pid, None)
    save_state()
    del loaded[pid]
    for k in [k for k in poller.health if k.startswith(f"plugin:{pl.manifest['name']}.")]:
        del poller.health[k]
    if not pl.dev and (ROOT / pid).exists():  # a folder was locked; try again on the next start
        log.warning("Couldn't delete %s fully", pl.dir)
    elif pl.dev and (ROOT / pid / "plugin.json").exists():  # an installed copy was hidden behind the dev folder
        await reload(pid)
    return {"ok": True}


# --- Settings > Plugins --------------------------------------------------------------------------------------------
@router.get("/plugins")
async def list_plugins():
    _, errors = discover()
    broken = [{"path": str(f), "error": str(e)} for f, e in errors]
    return {"plugins": [info(pl) for pl in sorted(loaded.values(), key=lambda p: p.manifest["name"].lower())],
            "broken": broken, "folder": str(ROOT), "api": wavelog.API, "notice": state.get("_notice")}


def coerce(spec, v):
    t = spec["type"]
    if t == "switch":
        return bool(v)
    if t in ("number", "slider"):
        v = float(v)
        lo, hi = spec.get("min"), spec.get("max")
        v = max(lo, v) if lo is not None else v
        return min(hi, v) if hi is not None else v
    if t == "choice":
        opts = [o[0] if isinstance(o, (list, tuple)) else o for o in spec.get("options") or []]
        if v not in opts:
            raise ValueError(f"{spec['key']} must be one of {opts}")
        return v
    return str(v)[:4000]


@router.put("/plugins/{pid}")
async def change(pid: str, body: dict = Body(...)):
    pl = find(pid)
    st = state.setdefault(pid, {})
    if "values" in body:
        specs = {s["key"]: s for s in pl.manifest.get("settings") or []}
        try:
            new = {k: coerce(specs[k], v) for k, v in body["values"].items() if k in specs}
        except (TypeError, ValueError) as e:
            raise HTTPException(400, str(e))
        st.setdefault("values", {}).update(new)
    if "enabled" in body:
        st["enabled"] = bool(body["enabled"])
    if "duck" in body:
        st["duck"] = bool(body["duck"])
    save_state()
    if "enabled" in body:
        if st["enabled"]:
            if pl.plugin:
                start(pl)
            else:
                await reload(pid)
        else:
            await stop(pl)
    if "values" in body and pl.plugin and pl.enabled and (h := pl.plugin.hooks.get("settings")):
        await safe(pl, h)
    return info(loaded[pid])


@router.post("/plugins/{pid}/reload")
async def reload_route(pid: str):
    find(pid)
    await reload(pid)
    return info(loaded[pid])


@router.get("/plugins/alerts")
async def plugin_alerts(after: int = 0):
    """Notch alerts from plugins, newer than `after`. Old ones (over 10 minutes) are left out."""
    now = time.time()
    return [a for a in alerts if a["id"] > after and now - a["at"] < 600 and loaded.get(a["plugin"]) and loaded[a["plugin"]].enabled]


# --- What plugins draw ---------------------------------------------------------------------------------------------
@router.get("/p/{pid}/page/{name}")
async def page(pid: str, name: str, range: str = "all", choice: str = None):
    pl = running(pid)
    if name not in pl.plugin.pages:
        raise HTTPException(404, "No such page")
    fn, _, ranges, choices = pl.plugin.pages[name]
    kw = {"range": range} if ranges else {}
    if choices:
        kw["choice"] = choice if any(c[0] == choice for c in choices) else choices[0][0]
    return await blocks(pl, fn, **kw)


@router.get("/p/{pid}/widget/{name}")
async def widget(pid: str, name: str, size: str = "m"):
    pl = running(pid)
    if name not in pl.plugin.widgets:
        raise HTTPException(404, "No such widget")
    return await blocks(pl, pl.plugin.widgets[name][0], size=size)


@router.get("/p/{pid}/notch/{name}")
async def notch(pid: str, name: str):
    pl = running(pid)
    if name not in pl.plugin.sections:
        raise HTTPException(404, "No such section")
    return await blocks(pl, pl.plugin.sections[name][0])


@router.get("/p/{pid}/overlay/{name}")
async def overlay(pid: str, name: str):
    pl = running(pid)
    fn = next((o[0] for o in pl.plugin.overlays if o[0].__name__ == name), None)
    if not fn:
        raise HTTPException(404, "No such overlay")
    return await blocks(pl, fn)


async def ducking():
    """True while a plugin wants Spotify quieter (and the user left that on in Settings > Sound)."""
    for pl in list(loaded.values()):
        if not (pl.plugin and pl.enabled and pl.plugin.ducks and state.get(pl.id, {}).get("duck", True)):
            continue
        for fn in pl.plugin.ducks:
            try:
                if await asyncio.wait_for(call(pl, fn), 2):
                    return True
            except Exception as e:
                pl.last_error = f"Ducking: {type(e).__name__}: {e}"[:400]
    return False


@router.post("/p/{pid}/action/{name}")
async def action(pid: str, name: str, args: dict = Body(default={})):
    pl = running(pid)
    fn = pl.plugin.actions.get(name)
    if not fn:
        raise HTTPException(404, f"The plugin has no action called {name}")
    try:
        out = await call(pl, fn, **(args or {}))
    except Exception as e:
        log.exception("Plugin %s: action %s failed", pid, name)
        pl.last_error = f"{type(e).__name__}: {e}"[:400]
        raise HTTPException(500, pl.last_error)
    return json.loads(json.dumps(clean(pl, out), default=str)) if out is not None else None


@router.get("/p/{pid}/file/{path:path}")
async def plugin_file(pid: str, path: str):
    pl = find(pid)
    f = (pl.dir / path).resolve()
    if not f.is_relative_to(pl.dir.resolve()) or f.suffix.lower() not in IMAGES or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, media_type=IMAGES[f.suffix.lower()], headers={"Cache-Control": "max-age=300"})


@router.get("/p/{pid}/img")
async def plugin_image(pid: str, u: str):
    """A web image for a plugin, fetched once and kept in its data folder."""
    pl = find(pid)
    if not u.startswith(("https://", "http://")):
        raise HTTPException(400)
    folder = STORE / pid / "images"
    folder.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(u.encode()).hexdigest()[:24]
    hit = next(folder.glob(key + ".*"), None)
    if not hit:
        try:
            r = await http.get(u)
            r.raise_for_status()
        except httpx.HTTPError:
            raise HTTPException(502)
        kind = r.headers.get("content-type", "").split(";")[0].strip()
        ext = next((e for e, t in IMAGES.items() if t == kind), None)
        if not ext or len(r.content) > 8_000_000:
            raise HTTPException(415)
        files = sorted(folder.iterdir(), key=lambda f: f.stat().st_mtime)
        for old in files[:-400]:  # keep the cache small
            old.unlink(missing_ok=True)
        hit = folder / (key + ext)
        hit.write_bytes(r.content)
    return FileResponse(hit, media_type=IMAGES[hit.suffix], headers={"Cache-Control": "max-age=86400"})
