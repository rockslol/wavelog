import json
import logging
import os
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path

from paths import installed_dir


def data_dir():
    """WAVELOG_DATA if set, the installed folder when frozen, data/ next to the code when run from source."""
    if os.environ.get("WAVELOG_DATA"):
        return Path(os.environ["WAVELOG_DATA"])
    return installed_dir() if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent / "data"


DATA = data_dir()
DATA.mkdir(parents=True, exist_ok=True)


def read_json(path, default):
    """A JSON file, or `default` when it's missing. A broken file is kept as <name>.bad and doesn't stop the logger."""
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        logging.getLogger("db").error("%s is unreadable (%s), starting it fresh; the old one is kept as .bad", path, e)
        try:
            Path(path).replace(Path(path).with_name(Path(path).name + ".bad"))
        except OSError:
            pass
        return default


def write_json(path, value, indent=None):
    """Writes a temporary file and swaps it in, so a crash mid-write never leaves a half-written file."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=indent), "utf-8")
    tmp.replace(path)

db = sqlite3.connect(DATA / "spotify.db", check_same_thread=False, isolation_level=None, timeout=30)
db.executescript("""
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS artists (id TEXT PRIMARY KEY, name TEXT, image_url TEXT);
CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, name TEXT, image_url TEXT, release_date TEXT);
CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, name TEXT, album_id TEXT, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS track_artists (track_id TEXT, artist_id TEXT, position INTEGER, PRIMARY KEY (track_id, artist_id));
CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY,
    track_id TEXT NOT NULL,
    played_at TEXT NOT NULL,
    ms_played INTEGER,
    context TEXT,
    source TEXT,
    UNIQUE (track_id, played_at)
);
CREATE INDEX IF NOT EXISTS plays_time ON plays (played_at);
CREATE TABLE IF NOT EXISTS skips (track_id TEXT, skipped_at TEXT, ms_played INTEGER, PRIMARY KEY (track_id, skipped_at));
""")


def ts(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t))


def save_track(t):
    al = t["album"]
    db.execute(
        "INSERT INTO albums VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, image_url=excluded.image_url",
        (al["id"], al["name"], (al.get("images") or [{}])[0].get("url"), al.get("release_date")),
    )
    db.execute("INSERT OR REPLACE INTO tracks VALUES (?,?,?,?)", (t["id"], t["name"], al["id"], t["duration_ms"]))
    for i, a in enumerate(t["artists"]):
        db.execute("INSERT OR IGNORE INTO artists (id, name) VALUES (?,?)", (a["id"], a["name"]))
        db.execute("INSERT OR IGNORE INTO track_artists VALUES (?,?,?)", (t["id"], a["id"], i))


async def backup():
    out = DATA / "backups"
    out.mkdir(exist_ok=True)
    f = out / f"spotify-{date.today()}.db"
    if not f.exists():
        dest = sqlite3.connect(f)
        db.backup(dest)
        dest.close()
        for old in sorted(out.glob("spotify-*.db"))[:-14]:
            old.unlink()
