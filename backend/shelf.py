"""File shelf: files dragged onto the notch are parked here until they're dragged out again, removed or expire.

Only references are kept (the path), never copies, so a file that's moved or deleted drops off the shelf.
"""
import asyncio
import json
import os
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response

import notifs
import widgets
from db import DATA

router = APIRouter(prefix="/shelf")
FILE = DATA / "shelf.json"
MAX = 30
thumbs = {}  # (path, mtime) -> PNG bytes or None


def load():
    try:
        return json.loads(FILE.read_text())
    except (OSError, ValueError):
        return []


def save(items):
    FILE.write_text(json.dumps(items, indent=2))


def current():
    """The shelf without files that are gone or older than the expiry set in Settings > Notch."""
    items = load()
    hours = (widgets.settings.get("notch") or {}).get("shelf_expire", 24)
    keep = [i for i in items if os.path.exists(i["path"]) and not (hours and time.time() - i["added"] > hours * 3600)]
    if len(keep) != len(items):
        save(keep)
    return keep


def describe(i):
    p = Path(i["path"])
    folder = p.is_dir()
    try:
        size = None if folder else p.stat().st_size
    except OSError:
        size = None
    return {"id": i["id"], "path": i["path"], "name": p.name or i["path"], "folder": folder, "size": size, "added": i["added"]}


def find(item_id):
    for i in current():
        if i["id"] == item_id:
            return i
    raise HTTPException(404)


@router.get("")
async def shelf():
    return [describe(i) for i in current()]


@router.post("")
async def add(paths: list[str] = Body(..., embed=True)):
    items = current()
    have = {os.path.normcase(i["path"]) for i in items}
    for p in paths:
        p = os.path.abspath(p)
        if os.path.exists(p) and os.path.normcase(p) not in have:
            have.add(os.path.normcase(p))
            items.append({"id": uuid.uuid4().hex[:12], "path": p, "added": time.time()})
    save(items[-MAX:])
    return await shelf()


@router.delete("/{item_id}")
async def remove(item_id: str):
    save([i for i in current() if i["id"] != item_id])
    return await shelf()


@router.delete("")
async def clear():
    save([])
    return []


@router.get("/{item_id}/thumb")
async def thumb(item_id: str):
    path = find(item_id)["path"]
    key = (path, os.path.getmtime(path))
    if key not in thumbs:
        thumbs[key] = await asyncio.get_running_loop().run_in_executor(notifs.shell, notifs.shell_image, path, 96, 0)
    if not thumbs[key]:
        raise HTTPException(404)
    return Response(thumbs[key], media_type="image/png", headers={"Cache-Control": "max-age=600"})


@router.post("/{item_id}/open")
async def open_item(item_id: str):
    os.startfile(find(item_id)["path"])
    return {"ok": True}
