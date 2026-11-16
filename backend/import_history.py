"""Imports Spotify's Extended streaming history from the command line. The app does the same in Settings > General.

    python import_history.py <the export's .zip, its folder, or json files> [--dev]

Writes to the installed app's data (%APPDATA%\\Wavelog), the database the app you use reads. --dev writes to data\\
next to the code instead, for a logger run from source. Wavelog can stay open while this runs.
"""
import os
import sys

from paths import installed_dir

dev = "--dev" in sys.argv
args = [a for a in sys.argv[1:] if a != "--dev"]
if not args:
    raise SystemExit(__doc__)
if not dev:
    os.environ.setdefault("WAVELOG_DATA", str(installed_dir()))

import history  # noqa: E402 (after WAVELOG_DATA is set: importing it opens the database)
from db import DATA  # noqa: E402

entries = [e for a in args for e in history.read_entries(a)]
counts = {"added": 0, "merged": 0, "short": 0}
for _ in history.steps(entries, counts):  # commits in chunks, so the running app can still write
    pass
missing = history.missing()
print(f"{DATA}: {counts['added']} plays added, {counts['merged']} matched existing plays, {counts['short']} under 30s skipped. "
      f"{missing} tracks need details, the running app fills them in (about {missing * 2 // 60} min).")
