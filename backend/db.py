import os
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path

def data_dir():
    """Installed: %APPDATA%\\Wavelog. Installs from before the rename keep using %APPDATA%\\Spotify Stats."""
    if not getattr(sys, "frozen", False):
        return Path(__file__).resolve().parent.parent / "data"
    base = Path(os.environ["APPDATA"])
    new, old = base / "Wavelog", base / "Spotify Stats"
    return old if old.exists() and not new.exists() else new


DATA = data_dir()
DATA.mkdir(parents=True, exist_ok=True)

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
