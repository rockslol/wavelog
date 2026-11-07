import asyncio
import colorsys
import csv
import io
import time
from collections import defaultdict
from pathlib import Path
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from PIL import Image

import poller
from db import db, ts

router = APIRouter()
colors = {}
Range = Literal["today", "week", "month", "year", "all"]
R = Query("all", alias="range")
WHERE = "p.played_at >= ? AND p.played_at < ?"
ARTISTS = ("(SELECT group_concat(ar.name, ', ' ORDER BY ta.position) FROM track_artists ta "
           "JOIN artists ar ON ar.id = ta.artist_id WHERE ta.track_id = t.id)")
START = "datetime(unixepoch(p.played_at) - p.ms_played / 1000, 'unixepoch', 'localtime')"
TOP = {
    "tracks": f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image, count(*) AS plays, "
              "sum(p.ms_played) / 60000 AS minutes FROM plays p JOIN tracks t ON t.id = p.track_id "
              f"LEFT JOIN albums al ON al.id = t.album_id WHERE {WHERE} GROUP BY t.id",
    "artists": "SELECT ar.id, ar.name, ar.image_url AS image, count(*) AS plays, sum(p.ms_played) / 60000 AS minutes "
               "FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id JOIN artists ar ON ar.id = ta.artist_id "
               f"WHERE {WHERE} GROUP BY ar.id",
    "albums": "SELECT al.id, al.name, (SELECT ar.name FROM tracks t2 JOIN track_artists ta ON ta.track_id = t2.id "
              "JOIN artists ar ON ar.id = ta.artist_id WHERE t2.album_id = al.id AND ta.position = 0 LIMIT 1) AS artists, "
              "al.image_url AS image, count(*) AS plays, sum(p.ms_played) / 60000 AS minutes FROM plays p "
              f"JOIN tracks t ON t.id = p.track_id JOIN albums al ON al.id = t.album_id WHERE {WHERE} GROUP BY al.id",
}


def span(r, year):
    if year:
        return ts(datetime(year, 1, 1).timestamp()), ts(datetime(year + 1, 1, 1).timestamp())
    if r == "today":
        return ts(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()), "9"
    days = {"week": 7, "month": 30, "year": 365}.get(r)
    return (ts(time.time() - days * 86400) if days else "0"), "9"


def q(sql, *args):
    c = db.execute(sql, args)
    cols = [d[0] for d in c.description]
    return [dict(zip(cols, row)) for row in c]


def runs(a, b):
    out = []
    for (d,) in db.execute(f"SELECT DISTINCT date(p.played_at, 'localtime') FROM plays p WHERE {WHERE} ORDER BY 1", (a, b)):
        d = date.fromisoformat(d)
        if out and (d - out[-1][1]).days == 1:
            out[-1][1] = d
        else:
            out.append([d, d])
    return out


@router.get("/now")
async def now():
    import spotify
    c = poller.cur
    if not c:
        return {"playing": False, "auth": spotify.auth_state()}
    t = c["track"]
    progress = c["progress"] + ((time.time() - c["poll"]) * 1000 if c["playing"] else 0)
    return {
        "playing": c["playing"], "id": t["id"], "name": t["name"],
        "artists": ", ".join(a["name"] for a in t["artists"]), "album": t["album"]["name"],
        "image": (t["album"].get("images") or [{}])[0].get("url"), "duration_ms": t["duration_ms"],
        "progress_ms": int(min(progress, t["duration_ms"])), "context": c["context"], "color": color(t),
        "auth": spotify.auth_state(),
    }


@router.post("/poke")
async def poke():
    await asyncio.sleep(0.8)
    await poller.poll_current()
    return await now()


@router.get("/lastfm")
async def lastfm_status():
    import lastfm
    return lastfm.status()


@router.post("/lastfm/sync")
async def lastfm_sync(full: bool = False):
    import lastfm
    lastfm.start(full)
    return lastfm.status()


upnext = {"id": None, "at": 0, "data": {}}
upnext_lock = asyncio.Lock()


def brief(t):
    return {"id": t.get("id"), "name": t["name"], "artists": ", ".join(a["name"] for a in t.get("artists", [])),
            "image": ((t.get("album") or {}).get("images") or [{}])[-1].get("url")}


@router.get("/upnext")
async def up_next():
    """Next tracks in the queue plus the playing device, cached per song for 30s."""
    import spotify
    tid = poller.cur and poller.cur["track"]["id"]
    if not tid:
        return {}
    async with upnext_lock:
        if upnext["id"] == tid and time.time() - upnext["at"] < 30:
            return upnext["data"]
        try:
            q_, p = await asyncio.wait_for(asyncio.gather(spotify.get("/me/player/queue"), spotify.get("/me/player")), 8)
        except Exception:
            return upnext["data"] if upnext["id"] == tid else {}
        dev = (p or {}).get("device") or {}
        data = {"next": [brief(t) for t in (q_ or {}).get("queue", []) if t.get("type") == "track"][:3],
                "device": dev.get("name"), "kind": (dev.get("type") or "").lower(),
                "shuffle": bool((p or {}).get("shuffle_state")), "repeat": (p or {}).get("repeat_state", "off")}
        upnext.update(id=tid, at=time.time(), data=data)
        return data


def color(t):
    url = (t["album"].get("images") or [{}])[-1].get("url")
    if url and url not in colors:
        colors[url] = None
        asyncio.create_task(load_color(url))
    return colors.get(url)


async def load_color(url):
    from widgets import http
    try:
        im = Image.open(io.BytesIO((await http.get(url)).content)).convert("RGB").resize((24, 24))
    except Exception:
        colors.pop(url, None)
        return
    r = g = b = n = 0
    for px in im.getdata():
        h, l, sat = colorsys.rgb_to_hls(*(v / 255 for v in px))
        w = sat * sat * min(l, 1 - l) * 2 + 0.01
        r, g, b, n = r + px[0] * w, g + px[1] * w, b + px[2] * w, n + w
    h, l, sat = colorsys.rgb_to_hls(r / n / 255, g / n / 255, b / n / 255)
    colors[url] = [round(v, 3) for v in colorsys.hls_to_rgb(h, 0.3, min(sat * 1.2, 0.85))]


@router.get("/years")
async def years():
    return [int(y) for (y,) in db.execute("SELECT DISTINCT strftime('%Y', played_at, 'localtime') FROM plays ORDER BY 1 DESC")]


@router.get("/today")
async def today():
    ms = db.execute(f"SELECT coalesce(sum(p.ms_played), 0) FROM plays p WHERE {WHERE}", span("today", None)).fetchone()[0]
    return {"minutes": round((ms + (poller.cur["progress"] if poller.cur else 0)) / 60000)}


def totals(a, b):
    return q(f"SELECT count(*) AS plays, coalesce(sum(p.ms_played), 0) / 60000 AS minutes, "
             f"count(DISTINCT p.track_id) AS tracks, (SELECT count(DISTINCT ta.artist_id) FROM plays p "
             f"JOIN track_artists ta ON ta.track_id = p.track_id WHERE {WHERE}) AS artists FROM plays p WHERE {WHERE}",
             a, b, a, b)[0]


def previous(r):
    """The same-length period just before the current one: yesterday up to this time for today,
    the 7/30/365 days before the last 7/30/365. None for all time."""
    now = time.time()
    if r == "today":
        start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        return ts(start - 86400), ts(now - 86400)
    days = {"week": 7, "month": 30, "year": 365}.get(r)
    return (ts(now - 2 * days * 86400), ts(now - days * 86400)) if days else None


@router.get("/summary")
async def summary(r: Range = R, year: int = None):
    out = totals(*span(r, year))
    prev = None if year else previous(r)
    return out | {"prev": totals(*prev) if prev else None}


@router.get("/top/{kind}")
async def top(kind: Literal["tracks", "artists", "albums"], r: Range = R, year: int = None, limit: int = 10):
    return q(TOP[kind] + " ORDER BY plays DESC, minutes DESC LIMIT ?", *span(r, year), limit)


@router.get("/hours")
async def hours(r: Range = R, year: int = None):
    rows = dict(db.execute(f"SELECT cast(strftime('%H', {START}) AS int), sum(p.ms_played) FROM plays p "
                           f"WHERE {WHERE} GROUP BY 1", span(r, year)).fetchall())
    return [{"hour": h, "minutes": round(rows.get(h, 0) / 60000)} for h in range(24)]


@router.get("/weekdays")
async def weekdays(r: Range = R, year: int = None):
    rows = dict(db.execute(f"SELECT cast(strftime('%w', {START}) AS int), sum(p.ms_played) FROM plays p "
                           f"WHERE {WHERE} GROUP BY 1", span(r, year)).fetchall())
    names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    return [{"day": names[d], "minutes": round(rows.get(d, 0) / 60000)} for d in (1, 2, 3, 4, 5, 6, 0)]


@router.get("/days")
async def days(r: Range = R, year: int = None):
    return q(f"SELECT date(p.played_at, 'localtime') AS day, count(*) AS plays, sum(p.ms_played) / 60000 AS minutes "
             f"FROM plays p WHERE {WHERE} GROUP BY 1 ORDER BY 1", *span(r, year))


@router.get("/streaks")
async def streaks(r: Range = R, year: int = None):
    last = (runs("0", "9") or [[None, None]])[-1]
    current = (last[1] - last[0]).days + 1 if last[1] and (date.today() - last[1]).days <= 1 else 0
    best = max(runs(*span(r, year)), key=lambda x: x[1] - x[0], default=None)
    return {"current": current,
            "longest": best and {"days": (best[1] - best[0]).days + 1, "start": str(best[0]), "end": str(best[1])}}


@router.get("/binged")
async def binged(r: Range = R, year: int = None, limit: int = 10):
    a, b = span(r, year)
    plays = defaultdict(list)
    for tid, t in db.execute("SELECT track_id, unixepoch(played_at) FROM plays ORDER BY played_at"):
        plays[tid].append(t)
    out = []
    for tid, times in plays.items():
        n, i, j, lo = 0, 0, 0, 0
        for hi, t in enumerate(times):
            while t - times[lo] > 7 * 86400:
                lo += 1
            if hi - lo + 1 > n:
                n, i, j = hi - lo + 1, lo, hi
        after = len(times) - j - 1
        if n >= 5 and a <= ts(times[i]) < b and time.time() - times[j] > 30 * 86400 and after <= n // 4:
            out.append((n - after, tid, n, times[i], times[j], after))
    out.sort(reverse=True)
    return [{**q(f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image FROM tracks t "
                 "LEFT JOIN albums al ON al.id = t.album_id WHERE t.id = ?", tid)[0],
             "binge_plays": n, "binge_start": str(date.fromtimestamp(s)), "binge_end": str(date.fromtimestamp(e)),
             "plays_after": after}
            for _, tid, n, s, e, after in out[:limit]]


MONTHS = "SELECT strftime('%Y-%m', p.played_at, 'localtime') AS month, count(*) AS plays, sum(p.ms_played) / 60000 AS minutes"
PEAK = "SELECT min(date(p.played_at, 'localtime')) AS start, count(*) AS plays"
STATS = ("SELECT count(*) AS plays, coalesce(sum(p.ms_played), 0) / 60000 AS minutes, "
         "datetime(min(p.played_at), 'localtime') AS first, datetime(max(p.played_at), 'localtime') AS last")


@router.get("/track/{id}")
async def track(id: str):
    t = q(f"SELECT t.id, t.name, al.name AS album, al.image_url AS image, t.duration_ms FROM tracks t "
          "LEFT JOIN albums al ON al.id = t.album_id WHERE t.id = ?", id)
    if not t:
        raise HTTPException(404)
    where = "FROM plays p WHERE p.track_id = ?"
    return {**t[0], **q(f"{STATS} {where}", id)[0],
            "skips": db.execute("SELECT count(*) FROM skips WHERE track_id = ?", (id,)).fetchone()[0],
            "artists": q("SELECT ar.id, ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id "
                         "WHERE ta.track_id = ? ORDER BY ta.position", id),
            "months": q(f"{MONTHS} {where} GROUP BY 1 ORDER BY 1", id),
            "peak": (q(f"{PEAK} {where} GROUP BY strftime('%Y-%W', p.played_at, 'localtime') ORDER BY 2 DESC LIMIT 1", id) or [None])[0]}


@router.get("/artist/{id}")
async def artist(id: str):
    a = q("SELECT id, name, image_url AS image FROM artists WHERE id = ?", id)
    if not a:
        raise HTTPException(404)
    where = "FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id WHERE ta.artist_id = ?"
    return {**a[0], **q(f"{STATS}, count(DISTINCT p.track_id) AS tracks {where}", id)[0],
            "months": q(f"{MONTHS} {where} GROUP BY 1 ORDER BY 1", id),
            "peak": (q(f"{PEAK} {where} GROUP BY strftime('%Y-%W', p.played_at, 'localtime') ORDER BY 2 DESC LIMIT 1", id) or [None])[0],
            "top": q(f"SELECT t.id, t.name, al.image_url AS image, count(*) AS plays, sum(p.ms_played) / 60000 AS minutes "
                     f"FROM plays p JOIN tracks t ON t.id = p.track_id JOIN track_artists ta ON ta.track_id = t.id "
                     "LEFT JOIN albums al ON al.id = t.album_id WHERE ta.artist_id = ? GROUP BY t.id ORDER BY plays DESC LIMIT 10", id)}


@router.get("/heat")
async def heat(r: Range = R, year: int = None):
    grid = [[0] * 24 for _ in range(7)]
    for d, h, ms in db.execute(f"SELECT cast(strftime('%w', {START}) AS int), cast(strftime('%H', {START}) AS int), "
                               f"sum(p.ms_played) FROM plays p WHERE {WHERE} GROUP BY 1, 2", span(r, year)):
        grid[(d + 6) % 7][h] = round(ms / 60000)
    return grid


@router.get("/skips")
async def skipped(r: Range = R, year: int = None, limit: int = 10):
    a, b = span(r, year)
    return q(f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image, count(*) AS skips, "
             "(SELECT count(*) FROM plays p WHERE p.track_id = t.id AND p.played_at >= ? AND p.played_at < ?) AS plays "
             "FROM skips s JOIN tracks t ON t.id = s.track_id LEFT JOIN albums al ON al.id = t.album_id "
             "WHERE s.skipped_at >= ? AND s.skipped_at < ? GROUP BY t.id ORDER BY skips DESC, plays LIMIT ?", a, b, a, b, limit)


@router.get("/search")
async def search(q_: str = Query(alias="q")):
    s = q_.strip()
    # Names that start with the text first, then names with a word starting with it, then the rest; most played first.
    rank = "(n LIKE ?2) DESC, (' ' || n LIKE ?3) DESC, plays DESC"
    args = (f"%{s}%", f"{s}%", f"% {s}%")
    return {"tracks": q(f"SELECT * FROM (SELECT t.id, t.name, t.name AS n, {ARTISTS} AS artists, al.image_url AS image, "
                        "(SELECT count(*) FROM plays p WHERE p.track_id = t.id) AS plays FROM tracks t "
                        f"LEFT JOIN albums al ON al.id = t.album_id WHERE t.name LIKE ?1) ORDER BY {rank} LIMIT 6", *args),
            "artists": q("SELECT * FROM (SELECT ar.id, ar.name, ar.name AS n, ar.image_url AS image, (SELECT count(*) FROM plays p "
                         "JOIN track_artists ta ON ta.track_id = p.track_id WHERE ta.artist_id = ar.id) AS plays FROM artists ar "
                         f"WHERE ar.name LIKE ?1) ORDER BY {rank} LIMIT 4", *args)}


@router.post("/export")
async def export():
    rows = db.execute(f"SELECT datetime(p.played_at, 'localtime'), t.name, {ARTISTS}, al.name, p.ms_played, p.source, p.track_id "
                      "FROM plays p LEFT JOIN tracks t ON t.id = p.track_id LEFT JOIN albums al ON al.id = t.album_id "
                      "ORDER BY p.played_at").fetchall()
    out = Path.home() / "Downloads" / f"Spotify plays {date.today()}.csv"
    out.parent.mkdir(exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["played_at", "track", "artists", "album", "ms_played", "source", "track_id"])
        w.writerows(rows)
    return {"path": str(out), "rows": len(rows)}


@router.get("/daily")
async def daily(r: Range = R, year: int = None, limit: int = 60):
    return q(f"SELECT day, id, name, artists, image, plays FROM (SELECT date(p.played_at, 'localtime') AS day, t.id, t.name, "
             f"{ARTISTS} AS artists, al.image_url AS image, count(*) AS plays, row_number() OVER (PARTITION BY "
             "date(p.played_at, 'localtime') ORDER BY count(*) DESC, sum(p.ms_played) DESC) AS rk FROM plays p "
             f"JOIN tracks t ON t.id = p.track_id LEFT JOIN albums al ON al.id = t.album_id WHERE {WHERE} GROUP BY 1, t.id) "
             "WHERE rk = 1 ORDER BY day DESC LIMIT ?", *span(r, year), limit)
