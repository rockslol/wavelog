import os
from pathlib import Path


def installed_dir():
    """Where the installed app keeps its data: %APPDATA%\\Wavelog. Installs from before the rename keep using
    %APPDATA%\\Spotify Stats."""
    base = Path(os.environ["APPDATA"])
    new, old = base / "Wavelog", base / "Spotify Stats"
    return old if old.exists() and not new.exists() else new
