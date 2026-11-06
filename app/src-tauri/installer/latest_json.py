"""Writes latest.json for a GitHub release, next to the installer.

Wavelog checks https://github.com/rockslol/wavelog/releases/latest/download/latest.json for updates.
After `npx tauri build` (with TAURI_SIGNING_PRIVATE_KEY set), run from the repo root:

    python app\\src-tauri\\installer\\latest_json.py "What changed in this version"

then upload the installer, its .sig and latest.json to a release tagged v<version>.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
conf = json.loads((HERE.parent / "tauri.conf.json").read_text(encoding="utf-8"))
version = conf["version"]
name = f"{conf['productName']}_{version}_x64-setup.exe"
bundle = HERE.parent / "target" / "release" / "bundle" / "nsis"
sig = bundle / (name + ".sig")
if not sig.exists():
    raise SystemExit(f"{sig} is missing. Build with TAURI_SIGNING_PRIVATE_KEY set so the installer gets signed.")

out = {
    "version": version,
    "notes": sys.argv[1] if len(sys.argv) > 1 else "",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig.read_text().strip(),
            "url": f"https://github.com/rockslol/wavelog/releases/download/v{version}/{name}",
        }
    },
}
(bundle / "latest.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
print(f"Wrote {bundle / 'latest.json'}. Upload it with {name} and {name}.sig to release v{version}.")
