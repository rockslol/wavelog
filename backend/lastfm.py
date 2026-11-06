"""Import Last.fm scrobbles as plays.

Each scrobble is matched to a Spotify track: first against tracks already in the db,
then with Spotify search. Matches (and misses) are cached in lastfm_map, so a song is
only ever searched once. A scrobble is skipped when the db already has a play of the
same song around that time (live, recently played or history import).
"""
import asyncio
import logging
import re
import time
import unicodedata
from collections import defaultdict

import httpx

import spotify
from db import db, save_track, ts

log = logging.getLogger("lastfm")
API = "https://ws.audioscrobbler.com/2.0/"
http = httpx.AsyncClient(timeout=30, headers={"User-Agent": "sp-stats (local listening stats app)"})
db.executescript("""
CREATE TABLE IF NOT EXISTS lastfm_map (artist TEXT, track TEXT, track_id TEXT, PRIMARY KEY (artist, track));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
""")
state = {"running": False, "phase": "", "done": 0, "total": 0, "songs": 0, "added": 0, "known": 0, "unmatched": 0, "error": None}
task = None
search_limit = 10


class LastfmError(Exception):
    pass


def kv(k, v=None):
    if v is None:
        row = db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return row and row[0]
    db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, str(v)))


async def call(method, user, key, **params):
    p = {"method": method, "user": user, "api_key": key, "format": "json", **params}
    for attempt in range(6):
        try:
            r = await http.get(API, params=p)
            j = r.json()
        except (httpx.TransportError, ValueError):
            await asyncio.sleep(2 ** attempt)
            continue
        err = j.get("error") if isinstance(j, dict) else None
        if err in (8, 11, 16, 29) or (not err and r.status_code >= 500):  # temporary or rate limited
            await asyncio.sleep(2 ** attempt + 1)
            continue
        if err == 17:
            raise LastfmError("This profile hides its listening. Turn off 'Hide recent listening' in Last.fm privacy settings")
        if err:
            raise LastfmError(j.get("message") or f"Last.fm error {err}")
        return j
    raise LastfmError("Last.fm isn't answering, try again later")


async def check(user, key):
    """Raises LastfmError if the username or key is wrong. Returns the scrobble count."""
    j = await call("user.getinfo", user, key)
    return int(j["user"].get("playcount") or 0)


def norm(s):
    s = "".join(c for c in unicodedata.normalize("NFKD", (s or "").lower()) if not unicodedata.combining(c))
    s = re.sub(r"\s+-\s+.*$", "", s) or s  # " - 2011 Remaster"
    s = re.sub(r"\s*[(\[].*?[)\]]", "", s).strip() or s  # (feat. x), [Remastered], but keep titles like "(dream)"
    s = re.sub(r"\s+(feat|ft|featuring)\.?\s.*$", "", s)
    return re.sub(r"\W+", "", s)


def same_artist(lastfm, names):
    a = norm(lastfm)
    return any(n and (n == a or (len(n) >= 3 and (a.startswith(n) or n.startswith(a)))) for n in map(norm, names))


def local_index():
    """norm(track name) -> [(norm(artist), track id)], most played first."""
    idx = defaultdict(list)
    rows = db.execute("SELECT t.id, t.name, ar.name FROM tracks t JOIN track_artists ta ON ta.track_id = t.id "
                      "JOIN artists ar ON ar.id = ta.artist_id "
                      "ORDER BY (SELECT count(*) FROM plays p WHERE p.track_id = t.id) DESC")
    for tid, name, artist in rows:
        idx[norm(name)].append((artist, tid))
    return idx


async def search(name, artist):
    global search_limit
    clean = lambda s: re.sub(r"[\"':]", " ", s)
    for q in (f"track:{clean(name)} artist:{clean(artist)}", f"{clean(name)} {clean(artist)}"):
        try:
            d = await spotify.get("/search", q=q, type="track", limit=search_limit)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 400 and search_limit > 5:
                search_limit = 5
                return await search(name, artist)
            log.warning("Search failed for %s - %s (%s)", artist, name, e.response.status_code)
            return None
        items = [t for t in ((d or {}).get("tracks") or {}).get("items") or [] if t and t.get("id")]
        good = [t for t in items if same_artist(artist, [a["name"] for a in t["artists"]])]
        n = norm(name)
        exact = [t for t in good if norm(t["name"]) == n]
        close = [t for t in good if n and (norm(t["name"]).startswith(n) or n.startswith(norm(t["name"]) or "-"))]
        if exact or close:
            return (exact or close)[0]
    return None


async def resolve(artist, name, idx):
    row = db.execute("SELECT track_id FROM lastfm_map WHERE artist=? AND track=?", (artist, name)).fetchone()
    if row:
        return row[0] or None
    tid = next((t for a, t in idx.get(norm(name), []) if same_artist(artist, [a])), None)
    if not tid:
        t = await search(name, artist)
        if t:
            save_track(t)
            tid = t["id"]
        await asyncio.sleep(0.3)
    db.execute("INSERT OR REPLACE INTO lastfm_map VALUES (?,?,?)", (artist, name, tid or ""))
    return tid


def insert(tid, name, times, used):
    dur = (db.execute("SELECT duration_ms FROM tracks WHERE id=?", (tid,)).fetchone() or [None])[0] or 180000
    n = norm(name)
    db.execute("BEGIN")
    try:
        for start in sorted(times):
            end = start + dur / 1000  # scrobbles carry the start time, plays store the end time
            near = db.execute(
                "SELECT p.id, p.track_id, t.name FROM plays p LEFT JOIN tracks t ON t.id = p.track_id "
                "WHERE p.played_at BETWEEN ? AND ? ORDER BY abs(unixepoch(p.played_at) - ?)",
                (ts(start - 60), ts(end + 90), end)).fetchall()
            hit = next((pid for pid, ptid, pname in near if pid not in used and (ptid == tid or norm(pname) == n)), None)
            if hit:
                used.add(hit)
                state["known"] += 1
                continue
            c = db.execute("INSERT OR IGNORE INTO plays (track_id, played_at, ms_played, source) VALUES (?,?,?,'lastfm')",
                           (tid, ts(end), dur))
            if c.rowcount:
                used.add(c.lastrowid)
                state["added"] += 1
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


async def sync(full=False):
    from widgets import settings
    user, key = settings.get("lastfm_user"), settings.get("lastfm_key")
    if not (user and key):
        return
    if kv("lastfm_user") != user.lower():
        kv("lastfm_user", user.lower())
        kv("lastfm_synced", 0)
        full = True
    since = 0 if full else max(0, int(kv("lastfm_synced") or 0) - 86400)
    # Leave the last few minutes to the live poller, so a song playing right now isn't counted twice.
    until = int(time.time()) - 900
    state.update(running=True, phase="Reading your scrobbles", done=0, total=0, songs=0, added=0, known=0, unmatched=0,
                 error=None, full=full, started=time.time())
    try:
        scrobbles, page, pages = [], 1, 1
        while page <= pages:
            j = await call("user.getrecenttracks", user, key, limit=200, page=page, to=until, **({"from": since} if since else {}))
            rt = j["recenttracks"]
            pages, state["total"] = int(rt["@attr"]["totalPages"] or 0), int(rt["@attr"]["total"] or 0)
            items = rt.get("track") or []
            for t in items if isinstance(items, list) else [items]:
                if "date" in t and not (t.get("@attr") or {}).get("nowplaying"):
                    scrobbles.append((int(t["date"]["uts"]), t["artist"]["#text"], t["name"]))
            state["done"] = len(scrobbles)
            page += 1
            await asyncio.sleep(0.25)

        groups = defaultdict(list)
        for start, artist, name in scrobbles:
            groups[(artist, name)].append(start)
        state.update(phase="Matching songs to Spotify", done=0, total=len(scrobbles), songs=len(groups))
        idx, used = local_index(), set()
        for (artist, name), times in sorted(groups.items(), key=lambda g: -len(g[1])):
            tid = await resolve(artist, name, idx)
            if tid:
                insert(tid, name, times, used)
            else:
                state["unmatched"] += len(times)
            state["done"] += len(times)
        newest = max((s for s, _, _ in scrobbles), default=0)
        kv("lastfm_synced", max(newest, int(kv("lastfm_synced") or 0)))
        kv("lastfm_last_run", int(time.time()))
        state["phase"] = "Done"
        log.info("Last.fm %s: %s scrobbles, %s added, %s already there, %s not on Spotify", "import" if full else "sync",
                 len(scrobbles), state["added"], state["known"], state["unmatched"])
    except LastfmError as e:
        state.update(error=str(e), phase="")
    except Exception:
        log.exception("Last.fm sync failed")
        state.update(error="Import failed, see app.log", phase="")
    finally:
        state["running"] = False


def start(full=False):
    global task
    if not state["running"]:
        state["running"] = True
        task = asyncio.create_task(sync(full))


async def auto():
    """Background: keep pulling new scrobbles once the first import has run."""
    from widgets import settings
    if settings.get("lastfm_user") and settings.get("lastfm_key") and kv("lastfm_last_run") and not state["running"]:
        start()
        await task


def status():
    from widgets import settings
    plays = db.execute("SELECT count(*) FROM plays WHERE source='lastfm'").fetchone()[0]
    misses = db.execute("SELECT count(*) FROM lastfm_map WHERE track_id=''").fetchone()[0]
    return {**state, "connected": bool(settings.get("lastfm_user") and settings.get("lastfm_key")),
            "user": settings.get("lastfm_user"), "plays": plays, "missing_songs": misses,
            "last_run": int(kv("lastfm_last_run") or 0) or None}
