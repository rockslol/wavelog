"""Spotify's Extended streaming history (spotify.com > Account > Privacy): every play since the account was made.

Takes the export's .zip, its folder, or single Streaming_History_Audio_*.json files. Plays under 30 s are skipped
like everywhere else, and a play the db already has (live, recently played, Last.fm) is matched instead of added twice.
Imported tracks only have a name at first; the logger's background job fills in album, cover and artists.
"""
import asyncio
import json
import logging
import time
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from db import db, ts

log = logging.getLogger("history")
router = APIRouter()
state = {"running": False, "done": 0, "total": 0, "added": 0, "merged": 0, "short": 0, "error": None, "finished": None}
PATTERN = "Streaming_History_Audio_"


def read_entries(path):
    p = Path(str(path).strip().strip('"'))
    if not p.exists():
        raise ValueError("Nothing at that path")
    out = []
    if p.is_dir():
        for f in sorted(p.rglob(PATTERN + "*.json")):
            out += json.loads(f.read_text("utf-8"))
    elif p.suffix.lower() == ".zip":
        with zipfile.ZipFile(p) as z:
            for n in sorted(z.namelist()):
                if Path(n).name.startswith(PATTERN) and n.endswith(".json"):
                    out += json.loads(z.read(n).decode("utf-8"))
    elif p.suffix.lower() == ".json":
        out += json.loads(p.read_text("utf-8"))
    else:
        raise ValueError("Pick the export's .zip, its folder or a Streaming_History_Audio .json file")
    if not out:
        raise ValueError(f"No {PATTERN}*.json files in it. The Extended streaming history export has them")
    return out


def steps(entries, counts, chunk=3000):
    """Imports the entries, committing every `chunk` of them and yielding how many are done, so the running logger
    gets its turn in between."""
    entries = sorted(entries, key=lambda e: e["ts"])
    used = set()
    db.execute("BEGIN")
    try:
        for n, e in enumerate(entries, 1):
            uri = e.get("spotify_track_uri") or ""
            if uri.startswith("spotify:track:"):
                if (e.get("ms_played") or 0) < 30000:
                    counts["short"] += 1
                else:
                    add(e, uri.split(":")[2], used, counts)
            if n % chunk == 0:
                db.execute("COMMIT")
                yield n
                db.execute("BEGIN")
        db.execute("COMMIT")
        yield len(entries)
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise


def add(e, tid, used, counts):
    t = datetime.fromisoformat(e["ts"]).timestamp()
    db.execute("INSERT OR IGNORE INTO tracks (id, name) VALUES (?,?)", (tid, e.get("master_metadata_track_name")))
    near = db.execute("SELECT id FROM plays WHERE track_id=? AND abs(unixepoch(played_at) - ?) <= 60 "
                      "ORDER BY abs(unixepoch(played_at) - ?)", (tid, t, t)).fetchall()
    row = next((r for (r,) in near if r not in used), None)
    if row:
        db.execute("UPDATE plays SET ms_played=?, source='history' WHERE id=?", (e["ms_played"], row))
        counts["merged"] += 1
    else:
        c = db.execute("INSERT OR IGNORE INTO plays (track_id, played_at, ms_played, source) VALUES (?,?,?,'history')",
                       (tid, ts(t), e["ms_played"]))
        if not c.rowcount:
            return
        row = c.lastrowid
        counts["added"] += 1
    used.add(row)


def missing():
    return db.execute("SELECT count(*) FROM tracks WHERE album_id IS NULL").fetchone()[0]


async def run(entries):
    try:
        for n in steps(entries, state):
            state["done"] = n
            await asyncio.sleep(0)
        log.info("History import: %s plays added, %s matched, %s under 30 s skipped", state["added"], state["merged"], state["short"])
    except Exception as e:
        log.exception("History import failed")
        state["error"] = f"Import failed: {type(e).__name__}: {e}"[:300]
    finally:
        state.update(running=False, finished=time.time())


@router.get("/import/history")
async def status():
    return state | {"missing": missing()}


@router.post("/import/history")
async def start(body: dict = Body(...)):
    if state["running"]:
        raise HTTPException(409, "An import is already running")
    try:
        entries = await asyncio.to_thread(read_entries, body.get("path", ""))
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        raise HTTPException(400, str(e))
    state.update(running=True, done=0, total=len(entries), added=0, merged=0, short=0, error=None, finished=None)
    asyncio.create_task(run(entries))
    return await status()
