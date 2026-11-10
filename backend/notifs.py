"""Windows notifications for the notch: Discord, WhatsApp, Mail and so on drop out of it.

The proper API (UserNotificationListener) needs package identity, which an NSIS-installed app doesn't have. Windows
keeps every toast in its own SQLite database, %LOCALAPPDATA%\\Microsoft\\Windows\\Notifications\\wpndatabase.db, so
this reads that, read-only, whenever the file changes. A toast's payload is XML: the first <text> is the title
(usually the sender), the rest is the message. App names and icons come from the shell's Apps folder, by AUMID.
"""
import asyncio
import ctypes
import io
import os
import re
import sqlite3
import subprocess
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from PIL import Image

router = APIRouter()
DB = Path(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db"))
cache = {"stamp": None, "items": []}
names, icons = {}, {}  # aumid -> display name / PNG bytes (or None)
ole32, shell32, gdi32, user32 = ctypes.windll.ole32, ctypes.windll.shell32, ctypes.windll.gdi32, ctypes.windll.user32
shell = ThreadPoolExecutor(1, initializer=lambda: ole32.CoInitializeEx(None, 2))  # shell calls need a COM thread


# ---- shell: app name and icon from an AppUserModelID ----

class GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_uint32), ("b", ctypes.c_uint16), ("c", ctypes.c_uint16), ("d", ctypes.c_ubyte * 8)]

    def __init__(self, s):
        u = uuid.UUID(s)
        super().__init__(u.fields[0], u.fields[1], u.fields[2], (ctypes.c_ubyte * 8)(*u.bytes[8:]))


class SIZE(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32), ("biSizeImage", ctypes.c_uint32),
                ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_uint32), ("biClrImportant", ctypes.c_uint32)]


class BITMAP(ctypes.Structure):
    _fields_ = [("bmType", ctypes.c_long), ("bmWidth", ctypes.c_long), ("bmHeight", ctypes.c_long), ("bmWidthBytes", ctypes.c_long),
                ("bmPlanes", ctypes.c_uint16), ("bmBitsPixel", ctypes.c_uint16), ("bmBits", ctypes.c_void_p)]


IID_ITEM = GUID("43826d1e-e718-42ee-bc55-a1e261c37bfe")  # IShellItem
IID_IMAGES = GUID("bcc18b79-ba16-442f-80c4-8a59c30c463b")  # IShellItemImageFactory
shell32.SHCreateItemFromParsingName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
gdi32.GetObjectW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]


def vcall(obj, index, *types):
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *types)(vtbl[index])


def shell_item(name, iid):
    p = ctypes.c_void_p()
    ok = shell32.SHCreateItemFromParsingName(name, None, ctypes.byref(iid), ctypes.byref(p)) == 0
    return p if ok and p.value else None


def app_name(aumid):
    p = shell_item("shell:AppsFolder\\" + aumid, IID_ITEM)
    if not p:
        return None
    try:
        out = ctypes.c_wchar_p()
        if vcall(p, 5, ctypes.c_int, ctypes.POINTER(ctypes.c_wchar_p))(p, 0, ctypes.byref(out)) != 0:  # GetDisplayName
            return None
        name = out.value
        ole32.CoTaskMemFree(out)
        return name
    finally:
        vcall(p, 2)(p)  # Release


def shell_image(name, px, flags):
    """A shell item's picture as PNG: GetImage flags 0 = thumbnail (or icon), 0x5 = icon only."""
    p = shell_item(name, IID_IMAGES)
    if not p:
        return None
    hbm = ctypes.c_void_p()
    try:
        if vcall(p, 3, SIZE, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(p, SIZE(px, px), flags, ctypes.byref(hbm)) != 0:  # GetImage
            return None
    finally:
        vcall(p, 2)(p)
    try:
        bm = BITMAP()
        if not gdi32.GetObjectW(hbm, ctypes.sizeof(bm), ctypes.byref(bm)):
            return None
        w, h = bm.bmWidth, abs(bm.bmHeight)
        bi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        dc = user32.GetDC(None)
        lines = gdi32.GetDIBits(dc, hbm, 0, h, buf, ctypes.byref(bi), 0)
        user32.ReleaseDC(None, dc)
        if not lines:
            return None
        im = Image.frombuffer("RGBA", (w, h), buf.raw, "raw", "BGRA", 0, 1)
        if im.getchannel("A").getextrema() == (0, 0):  # photo thumbnails come without alpha
            im.putalpha(255)
        im.thumbnail((px, px))
        out = io.BytesIO()
        im.save(out, "PNG")
        return out.getvalue()
    finally:
        gdi32.DeleteObject(hbm)


def app_icon(aumid, px=64):
    return shell_image("shell:AppsFolder\\" + aumid, px, 0x5)


def pretty(aumid):
    """Fallback name from the id itself: com.squirrel.Discord.Discord -> Discord."""
    base = re.split(r"[!_]", aumid)[0].split(".")[-1]
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base) or aumid


async def name_of(aumid):
    if aumid not in names:
        names[aumid] = await asyncio.get_running_loop().run_in_executor(shell, app_name, aumid) or pretty(aumid)
    return names[aumid]


# ---- the database ----

def stamp():
    out = []
    for f in (DB, DB.with_name(DB.name + "-wal")):
        try:
            st = f.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def read():
    """Newest toasts, re-read only when Windows has written to the database."""
    s = stamp()
    if s == cache["stamp"]:
        return cache["items"]
    try:
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
        rows = c.execute("SELECT n.Id, h.PrimaryId, n.Payload, n.ArrivalTime FROM Notification n "
                         "JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Type = 'toast' "
                         "ORDER BY n.ArrivalTime DESC LIMIT 30").fetchall()
        c.close()
    except sqlite3.Error:
        return cache["items"]
    items = []
    for nid, aumid, payload, at in rows:
        try:
            x = ET.fromstring(payload)
        except (ET.ParseError, TypeError):
            continue
        texts = [t.text.strip() for t in x.iter("text") if t.text and t.text.strip()]
        if not texts:
            continue
        img = next((i.get("src") for i in x.iter("image") if i.get("placement") in (None, "appLogoOverride", "hero")), None)
        img = img and img.removeprefix("file:///").replace("/", "\\")
        items.append({"id": nid, "aumid": aumid, "title": texts[0], "body": " · ".join(texts[1:3]),
                      "image": img if img and os.path.isfile(img) else None,
                      "launch": x.get("launch") if x.get("activationType") == "protocol" else None,
                      "at": at / 1e7 - 11644473600})  # FILETIME -> unix
    cache.update(stamp=s, items=items)
    return items


def find(nid):
    hit = next((n for n in read() if n["id"] == nid), None)
    if not hit:
        raise HTTPException(404)
    return hit


async def recent():
    """For /pc/live: what the notch needs, without file paths or launch links."""
    out = []
    for n in read():
        name = await name_of(n["aumid"])
        if name == "Wavelog":
            continue
        out.append({"id": n["id"], "aumid": n["aumid"], "app": name, "title": n["title"], "body": n["body"], "img": bool(n["image"]), "at": n["at"]})
    return out


@router.get("/pc/notif-apps")
async def notif_apps():
    """Apps with notifications right now, for the mute list in Settings."""
    seen = {}
    for n in read():
        seen.setdefault(n["aumid"], 0)
        seen[n["aumid"]] += 1
    return [{"aumid": a, "name": await name_of(a), "count": k} for a, k in seen.items()]


@router.get("/pc/app-icon")
async def icon(aumid: str):
    if aumid not in icons:
        icons[aumid] = await asyncio.get_running_loop().run_in_executor(shell, app_icon, aumid)
    if not icons[aumid]:
        raise HTTPException(404)
    return Response(icons[aumid], media_type="image/png", headers={"Cache-Control": "max-age=86400"})


@router.get("/pc/notif/{nid}/image")
async def image(nid: int):
    """The picture in a toast (a sender's avatar, a screenshot), only ever the file that toast points to."""
    path = find(nid)["image"]
    if not path:
        raise HTTPException(404)
    try:
        im = Image.open(path)
        im.thumbnail((160, 160))
        out = io.BytesIO()
        im.convert("RGBA").save(out, "PNG")
    except Exception:
        raise HTTPException(404)
    return Response(out.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@router.post("/pc/notif/{nid}/open")
async def open_notif(nid: int):
    """Like clicking the toast: its own link if it has one (Snipping Tool opens the screenshot), else the app."""
    n = find(nid)
    link = n["launch"]
    if link and re.match(r"^[a-z][a-z0-9+.\-]*:", link, re.I) and not link.lower().startswith("file:"):
        os.startfile(link)
    else:
        subprocess.Popen(["explorer.exe", "shell:AppsFolder\\" + n["aumid"]], creationflags=subprocess.CREATE_NO_WINDOW)
    return {"ok": True}
