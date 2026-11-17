import time
from datetime import datetime

from db import db, ts

SONG = (25, 50, 100, 250, 500, 1000)
ARTIST = (100, 250, 500, 1000, 2500, 5000, 10000, 25000)
PLAYS = (1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000)
MINUTES = (1000, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000)

db.execute("CREATE TABLE IF NOT EXISTS milestones (id INTEGER PRIMARY KEY, kind TEXT, ref TEXT, n INTEGER, at REAL, "
           "text TEXT, sub TEXT, short TEXT, image TEXT, link TEXT, UNIQUE (kind, ref, n))")


def ordinal(n):
    return f"{n:,}" + ("th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def short(n):
    return f"{n // 1000}k" if n >= 10000 else f"{n:,}"


def add(kind, ref, n, text, sub, tag, image, link):
    db.execute("INSERT OR IGNORE INTO milestones (kind, ref, n, at, text, sub, short, image, link) VALUES (?,?,?,?,?,?,?,?,?)",
               (kind, ref, n, time.time(), text, sub, tag, image, link))


def crossed(steps, before, after):
    return [s for s in steps if before < s <= after]


def check(t, ms):
    """Called after a live play is saved. A count only reaches a step once, and the table keeps each one unique,
    so history imports (which don't come through here) never set anything off."""
    cover = ((t.get("album") or {}).get("images") or [{}])[0].get("url")
    n = db.execute("SELECT count(*) FROM plays WHERE track_id = ?", (t["id"],)).fetchone()[0]
    for s in crossed(SONG, n - 1, n):
        add("song", t["id"], s, f"{ordinal(s)} play of {t['name']}", ", ".join(a["name"] for a in t["artists"]), ordinal(s), cover, f"track/{t['id']}")
    main = (t.get("artists") or [None])[0]
    if main and main.get("id"):
        n = db.execute("SELECT count(*) FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id WHERE ta.artist_id = ?",
                       (main["id"],)).fetchone()[0]
        img = (db.execute("SELECT image_url FROM artists WHERE id = ?", (main["id"],)).fetchone() or [None])[0] or cover
        for s in crossed(ARTIST, n - 1, n):
            add("artist", main["id"], s, f"{s:,} plays of {main['name']}", "All time", short(s), img, f"artist/{main['id']}")
    n = db.execute("SELECT count(*) FROM plays").fetchone()[0]
    for s in crossed(PLAYS, n - 1, n):
        add("plays", "", s, f"{s:,} plays logged", "Since your first song", short(s), cover, None)
    year = datetime.now().year
    start = ts(datetime(year, 1, 1).timestamp())
    after = db.execute("SELECT coalesce(sum(ms_played), 0) FROM plays WHERE played_at >= ?", (start,)).fetchone()[0] / 60000
    for s in crossed(MINUTES, after - ms / 60000, after):
        add("minutes", str(year), s, f"{s:,} minutes in {year}", f"That's {s // 60:,} hours of music", f"{short(s)} min", cover, None)


def since(after, limit=20):
    """Milestones after an id, oldest first. A negative id gives the newest ones (a fresh notch catching up)."""
    order = "id > ? ORDER BY id" if after >= 0 else "id > ? ORDER BY id DESC"
    c = db.execute(f"SELECT id, kind, n, at, text, sub, short, image, link FROM milestones WHERE {order} LIMIT ?", (after, limit))
    cols = [d[0] for d in c.description]
    return [dict(zip(cols, r)) for r in c]
