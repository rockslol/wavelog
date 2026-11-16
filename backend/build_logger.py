"""Builds wavelog-logger.exe and copies it to where `npx tauri build` picks it up. From the repo root:

    backend\\.venv\\Scripts\\python backend\\build_logger.py

Everything plugins may import (wavelog.MODULES) goes into the exe, and the Valorant plugin from ..\\wavelog-plugins is
bundled for users moving up from before 0.10.0 (plugins.adopt_valorant).
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from wavelog import MODULES  # noqa: E402

args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--noconsole", "--name", "wavelog-logger",
        "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
        "--add-data", f"{ROOT / 'backend' / 'fonts'};fonts", "--collect-submodules", "uvicorn",
        "--collect-data", "recurring_ical_events"]
args += [x for m in MODULES for x in ("--hidden-import", m)]
valorant = ROOT.parent / "wavelog-plugins" / "valorant"
if (valorant / "plugin.json").exists():
    args += ["--add-data", f"{valorant};bundled/valorant"]
else:
    print(f"Warning: {valorant} not found, so the Valorant plugin isn't bundled (needed for upgrades from before 0.10.0)")
subprocess.run(args + [str(ROOT / "backend" / "main.py")], check=True, cwd=ROOT)
dest = ROOT / "app" / "src-tauri" / "binaries" / "wavelog-logger-x86_64-pc-windows-msvc.exe"
dest.parent.mkdir(exist_ok=True)
shutil.copy2(ROOT / "dist" / "wavelog-logger.exe", dest)
print(f"Copied to {dest}")
