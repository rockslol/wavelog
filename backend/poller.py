import asyncio
import logging
import time
from collections import deque
from datetime import datetime

import httpx

import spotify
from db import db, save_track, ts

log = logging.getLogger("poller")
skips = deque(maxlen=200)
cur = None
lock = asyncio.Lock()


def finish(s, ended):
    t = s["track"]
    if s["playing"]:
        ms = min(t["duration_ms"], s["progress"] + max(0, ended - s["poll"]) * 1000)
        end = s["poll"] + (ms - s["progress"]) / 1000
    else:
        ms, end = s["progress"], s["playing_at"]
    if ms < 30000:
        skips.append((t["id"], s["start"], end))
        if ms < t["duration_ms"] - 5000:
            save_track(t)
            db.execute("INSERT OR IGNORE INTO skips VALUES (?,?,?)", (t["id"], ts(end), int(ms)))
        return
    save_track(t)
    row = db.execute(
        "SELECT id FROM plays WHERE track_id=? AND source IN ('recent', 'lastfm') AND unixepoch(played_at) BETWEEN ? AND ? "
        "ORDER BY abs(unixepoch(played_at) - ?) LIMIT 1",
        (t["id"], s["start"] - 60, end + 60, end),
    ).fetchone()
    if row:
        db.execute("UPDATE plays SET ms_played=?, source='synced' WHERE id=?", (int(ms), row[0]))
    else:
        db.execute(
            "INSERT OR IGNORE INTO plays (track_id, played_at, ms_played, context, source) VALUES (?,?,?,?,'live')",
            (t["id"], ts(end), int(ms), s["context"]),
        )
    log.info("Played %s (%ss)", t["name"], int(ms / 1000))


async def poll_current():
    async with lock:
        await read_current()


async def read_current():
    global cur
    d = await spotify.get("/me/player/currently-playing")
    now = time.time()
    item = d and d.get("item")
    if not item or item.get("type") != "track" or item.get("is_local") or not item.get("id"):
        item = None
    progress = (d.get("progress_ms") or 0) if item else 0
    if cur and (not item or item["id"] != cur["track"]["id"]
                or (progress < cur["progress"] - 10000 and progress < 30000)):
        finish(cur, now - progress / 1000)
        cur = None
    if item:
        if not cur:
            cur = dict(track=item, start=now - progress / 1000, playing_at=now,
                       context=(d.get("context") or {}).get("uri"))
        cur.update(progress=progress, poll=now, playing=d.get("is_playing", False))
        if cur["playing"]:
            cur["playing_at"] = now


async def poll_recent():
    d = await spotify.get("/me/player/recently-played", limit=50)
    for it in reversed(d["items"]):
        t = it["track"]
        if not t.get("id"):
            continue
        p = datetime.fromisoformat(it["played_at"]).timestamp()
        if any(tid == t["id"] and s - 60 <= p <= e + 60 for tid, s, e in skips):
            continue
        save_track(t)
        if db.execute("SELECT 1 FROM plays WHERE track_id=? AND played_at=?", (t["id"], ts(p))).fetchone():
            continue
        row = db.execute(
            "SELECT id FROM plays WHERE track_id=? AND source IN ('live', 'history', 'lastfm') "
            "AND ? BETWEEN unixepoch(played_at) - ms_played / 1000 - 60 AND unixepoch(played_at) + 60 "
            "ORDER BY abs(unixepoch(played_at) - ?) LIMIT 1",
            (t["id"], p, p),
        ).fetchone()
        if row:
            db.execute("UPDATE plays SET played_at=?, source='synced' WHERE id=?", (ts(p), row[0]))
        else:
            db.execute(
                "INSERT OR IGNORE INTO plays (track_id, played_at, ms_played, context, source) VALUES (?,?,?,?,'recent')",
                (t["id"], ts(p), t["duration_ms"], (it.get("context") or {}).get("uri")),
            )


async def fill_missing():
    if row := db.execute("SELECT id FROM tracks WHERE album_id IS NULL LIMIT 1").fetchone():
        try:
            t = await spotify.get(f"/tracks/{row[0]}")
            t["id"] = row[0]
            save_track(t)
        except httpx.HTTPStatusError as e:
            log.warning("Track %s lookup failed (%s), skipping", row[0], e.response.status_code)
            db.execute("UPDATE tracks SET album_id='' WHERE id=?", row)
    elif row := db.execute("SELECT id FROM artists WHERE image_url IS NULL LIMIT 1").fetchone():
        a = await spotify.get(f"/artists/{row[0]}")
        db.execute("UPDATE artists SET image_url=? WHERE id=?", ((a.get("images") or [{}])[0].get("url", ""), row[0]))


health = {}  # background job -> last run, last success, last error (shown in Settings > Advanced)


async def loop(fn, every):
    h = health.setdefault(f"{fn.__module__}.{fn.__name__}", {"runs": 0, "fails": 0, "last_run": None, "last_ok": None, "error": None})
    while True:
        h["last_run"] = time.time()
        h["runs"] += 1
        try:
            await fn()
            h.update(last_ok=time.time(), error=None)
        except Exception as e:
            h["fails"] += 1
            h["error"] = f"{type(e).__name__}: {e}"[:300]
            log.exception("%s failed", fn.__name__)
        await asyncio.sleep(every() if callable(every) else every)
