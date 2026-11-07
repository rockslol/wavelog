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
    """norm(track name) -> [(artist, track id)], most played first."""
    idx = defaultdict(list)
    rows = db.execute("SELECT t.id, t.name, ar.name FROM tracks t JOIN track_artists ta ON ta.track_id = t.id "
                      "JOIN artists ar ON ar.id = ta.artist_id "
                      "LEFT JOIN (SELECT track_id, count(*) n FROM plays GROUP BY track_id) c ON c.track_id = t.id "
                      "ORDER BY c.n DESC")
    for tid, name, artist in rows:
        idx[norm(name)].append((artist, tid))
    return idx


class Pace:
    """Spaces requests out to at most `rate` a second, shared by all workers."""

    def __init__(self, rate):
        self.gap, self.next, self.lock = 1 / rate, 0.0, asyncio.Lock()

    async def wait(self):
        async with self.lock:
            now = time.monotonic()
            at = max(now, self.next)
            self.next = at + self.gap
        await asyncio.sleep(at - now)


lastfm_pace = Pace(5)  # Last.fm asks for at most 5 requests a second
spotify_pace = Pace(8)


async def search(name, artist):
    global search_limit
    clean = lambda s: re.sub(r"[\"':]", " ", s)
    for q in (f"track:{clean(name)} artist:{clean(artist)}", f"{clean(name)} {clean(artist)}"):
        await spotify_pace.wait()
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


def write_map(rows):
    if not rows:
        return
    db.execute("BEGIN")
    try:
        db.executemany("INSERT OR REPLACE INTO lastfm_map VALUES (?,?,?)", rows)
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    rows.clear()


async def match(groups):
    """(artist, name) -> track id or None. Cache and local db first, then Spotify search for the rest, 8 at a time."""
    cache = {(a, t): tid or None for a, t, tid in db.execute("SELECT artist, track, track_id FROM lastfm_map")}
    idx, found, todo, new = local_index(), {}, [], []
    for key in groups:
        artist, name = key
        if key in cache:
            found[key] = cache[key]
        elif tid := next((t for a, t in idx.get(norm(name), []) if same_artist(artist, [a])), None):
            found[key] = tid
            new.append((artist, name, tid))
        else:
            todo.append(key)
            continue
        state["done"] += 1
    write_map(new)
    todo.sort(key=lambda k: len(groups[k]))  # most played last, so pop() takes them first

    async def worker():
        while todo:
            artist, name = key = todo.pop()
            t = await search(name, artist)
            if t:
                save_track(t)
            found[key] = t["id"] if t else None
            new.append((artist, name, found[key] or ""))
            if len(new) >= 100:
                write_map(new)
            state["done"] += 1

    try:
        await asyncio.gather(*(worker() for _ in range(8)))
    finally:
        write_map(new)  # keep what was found even if the import stops
    return found


def insert(tid, name, times, used, dur):
    n = norm(name)
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


async def read_scrobbles(user, key, since, until):
    """Every scrobble between since and until as (start, artist, name). Reads 5 pages at a time."""
    params = {"limit": 200, "to": until, **({"from": since} if since else {})}

    async def page(n):
        await lastfm_pace.wait()
        rt = (await call("user.getrecenttracks", user, key, page=n, **params))["recenttracks"]
        items = rt.get("track") or []
        out = [(int(t["date"]["uts"]), t["artist"]["#text"], t["name"])
               for t in (items if isinstance(items, list) else [items])
               if "date" in t and not (t.get("@attr") or {}).get("nowplaying")]
        state["done"] += len(out)
        return rt, out

    rt, scrobbles = await page(1)
    pages, state["total"] = int(rt["@attr"]["totalPages"] or 0), int(rt["@attr"]["total"] or 0)
    todo = list(range(pages, 1, -1))

    async def worker():
        while todo:
            scrobbles.extend((await page(todo.pop()))[1])

    await asyncio.gather(*(worker() for _ in range(5)))
    return scrobbles


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
        scrobbles = await read_scrobbles(user, key, since, until)
        groups = defaultdict(list)
        for start, artist, name in scrobbles:
            groups[(artist, name)].append(start)
        state.update(phase="Matching songs to Spotify", done=0, total=len(groups), songs=len(groups))
        found = await match(groups)

        state.update(phase="Adding plays", done=0, total=len(scrobbles))
        durs = dict(db.execute("SELECT id, duration_ms FROM tracks WHERE duration_ms"))
        used, batch = set(), 0
        db.execute("BEGIN")
        try:
            for (artist, name), times in groups.items():
                if tid := found.get((artist, name)):
                    insert(tid, name, times, used, durs.get(tid) or 180000)
                else:
                    state["unmatched"] += len(times)
                state["done"] += len(times)
                batch += len(times)
                if batch >= 3000:  # commit in chunks and let the rest of the logger run in between
                    db.execute("COMMIT")
                    await asyncio.sleep(0)
                    db.execute("BEGIN")
                    batch = 0
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        newest = max((s for s, _, _ in scrobbles), default=0)
        kv("lastfm_synced", max(newest, int(kv("lastfm_synced") or 0)))
        kv("lastfm_last_run", int(time.time()))
        state["phase"] = "Done"
        log.info("Last.fm %s: %s scrobbles, %s added, %s already there, %s not on Spotify, took %.0fs",
                 "import" if full else "sync", len(scrobbles), state["added"], state["known"], state["unmatched"],
                 time.time() - state["started"])
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
