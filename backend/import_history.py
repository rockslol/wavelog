import json
import sys
from datetime import datetime
from pathlib import Path

from db import db, ts

files = [f for a in sys.argv[1:] for f in
         (sorted(Path(a).glob("Streaming_History_Audio_*.json")) if Path(a).is_dir() else [Path(a)])]
if not files:
    raise SystemExit("Usage: python import_history.py <export folder or json files>")

entries = sorted((e for f in files for e in json.loads(f.read_text(encoding="utf-8"))), key=lambda e: e["ts"])
used, added, merged, short = set(), 0, 0, 0
db.execute("BEGIN")
for e in entries:
    uri = e.get("spotify_track_uri") or ""
    if not uri.startswith("spotify:track:"):
        continue
    if e["ms_played"] < 30000:
        short += 1
        continue
    tid, t = uri.split(":")[2], datetime.fromisoformat(e["ts"]).timestamp()
    db.execute("INSERT OR IGNORE INTO tracks (id, name) VALUES (?,?)", (tid, e["master_metadata_track_name"]))
    near = db.execute(
        "SELECT id FROM plays WHERE track_id=? AND abs(unixepoch(played_at) - ?) <= 60 ORDER BY abs(unixepoch(played_at) - ?)",
        (tid, t, t),
    ).fetchall()
    row = next((r for (r,) in near if r not in used), None)
    if row:
        db.execute("UPDATE plays SET ms_played=?, source='history' WHERE id=?", (e["ms_played"], row))
        merged += 1
    else:
        c = db.execute("INSERT OR IGNORE INTO plays (track_id, played_at, ms_played, source) VALUES (?,?,?,'history')",
                       (tid, ts(t), e["ms_played"]))
        if not c.rowcount:
            continue
        row = c.lastrowid
        added += 1
    used.add(row)
db.execute("COMMIT")
missing = db.execute("SELECT count(*) FROM tracks WHERE album_id IS NULL").fetchone()[0]
print(f"{added} plays added, {merged} matched existing plays, {short} under 30s skipped. "
      f"{missing} tracks need details, the running app fills them in (about {missing * 2 // 60} min).")
