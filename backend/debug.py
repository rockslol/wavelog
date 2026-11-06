"""Endpoints behind Settings > Advanced: status, logs and maintenance actions."""
import asyncio
import logging
import os
import platform
import sqlite3
import sys
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

import poller
import spotify
from db import DATA, db
from version import VERSION

router = APIRouter(prefix="/debug")
STARTED = time.time()
LOG = DATA / "app.log"
log = logging.getLogger("debug")


def one(sql):
    return db.execute(sql).fetchone()[0]


@router.get("/info")
async def info():
    import lastfm
    size = sum(f.stat().st_size for f in DATA.glob("spotify.db*") if f.is_file())
    lf = lastfm.status()
    return {
        "version": VERSION, "python": platform.python_version(), "os": platform.platform(terse=True),
        "pid": os.getpid(), "frozen": bool(getattr(sys, "frozen", False)), "started": STARTED, "port": spotify.PORT,
        "data_dir": str(DATA), "log_file": str(LOG), "log_level": logging.getLevelName(logging.getLogger().level),
        "db": {
            "plays": one("SELECT count(*) FROM plays"), "tracks": one("SELECT count(*) FROM tracks"),
            "artists": one("SELECT count(*) FROM artists"), "albums": one("SELECT count(*) FROM albums"),
            "missing": one("SELECT count(*) FROM tracks WHERE album_id IS NULL"), "size": size,
            "first": one("SELECT min(played_at) FROM plays"), "last": one("SELECT max(played_at) FROM plays"),
            "sources": dict(db.execute("SELECT coalesce(source, 'unknown'), count(*) FROM plays GROUP BY 1").fetchall()),
        },
        "spotify": {"client_id": bool(spotify.cfg.get("client_id")), "signed_in": bool(spotify.tokens)},
        "lastfm": {k: lf[k] for k in ("connected", "running", "plays", "last_run", "error")},
        "jobs": poller.health,
    }


@router.get("/log")
async def read_log(lines: int = 300):
    if not LOG.exists():
        return {"lines": []}
    with LOG.open("rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 400_000))
        text = f.read().decode("utf-8", "replace")
    return {"lines": text.splitlines()[-max(1, min(lines, 2000)):]}


@router.post("/loglevel")
async def set_level(level: str = Body(..., embed=True)):
    if level not in ("DEBUG", "INFO"):
        raise HTTPException(400, "level must be DEBUG or INFO")
    logging.getLogger().setLevel(level)
    log.info("Log level set to %s", level)
    return {"log_level": level}


@router.post("/backup")
async def backup_now():
    out = DATA / "backups"
    out.mkdir(exist_ok=True)
    f = out / time.strftime("manual-%Y-%m-%d-%H%M%S.db")
    dest = sqlite3.connect(f)
    db.backup(dest)
    dest.close()
    log.info("Manual backup saved to %s", f)
    return {"path": str(f), "size": f.stat().st_size}


@router.post("/clear-cache")
async def clear_cache():
    import api
    import widgets
    widgets.cache.clear()
    api.colors.clear()
    api.upnext.update(id=None, at=0, data={})
    n = 0
    for f in widgets.CACHE.glob("*"):
        if f.is_file():
            f.unlink(missing_ok=True)
            n += 1
    log.info("Caches cleared (%s cached photos removed)", n)
    return {"photos": n}


@router.post("/shutdown")
async def shutdown():
    """Used by Restart logger: the app starts a fresh one once this process is gone."""
    log.info("Shutting down for a restart")
    asyncio.get_running_loop().call_later(0.3, os._exit, 0)
    return {"ok": True}
