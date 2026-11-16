import asyncio
import ctypes
import hashlib
import io
import json
import logging
import random
import re
import sqlite3
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import httpx
import icalendar
import psutil
import recurring_ical_events
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

import poller
import spotify
from db import DATA, db, read_json, write_json

log = logging.getLogger("widgets")
router = APIRouter()
http = httpx.AsyncClient(timeout=30, follow_redirects=True, headers={"User-Agent": "Wavelog (local listening stats app)"})
FILE = DATA / "settings.json"
CACHE = DATA / "photo-cache"
CACHE.mkdir(exist_ok=True)
DEFAULTS = {"widgets": ["widget"], "sizes": {}, "scale": 1.0, "tint": 0.4, "locked": False, "stack": ["widget", "weather"],
            "now_lyrics": True, "calendars": [], "album": "", "folder": "", "photo_seconds": 30,
            "city": "", "place": "", "lat": None, "lon": None, "fahrenheit": False,
            "cover_glass": True, "countdowns": [], "todos": [], "pomodoro": [25, 5], "note": "",
            "overlay": [], "notch": {}, "lastfm_user": "", "lastfm_key": "", "steam_key": "", "steam_id": ""}
# Settings from before 0.10.0 (valorant, tab_y, val_wishlist) stay in the file: plugins.py reads them once when Valorant
# moves into its plugin.
settings = {**DEFAULTS, **read_json(FILE, {})}
cache = {}
db.execute("CREATE TABLE IF NOT EXISTS lyrics (track_id TEXT PRIMARY KEY, synced TEXT, plain TEXT)")
for col in ("source TEXT", "checked INTEGER"):  # checked: when "no lyrics" was last confirmed, to look again later
    try:
        db.execute(f"ALTER TABLE lyrics ADD COLUMN {col}")
    except sqlite3.OperationalError:
        pass
CREDIT = re.compile(r"^[^:：]{0,12}[㐀-鿿][^:：]{0,12}[:：]")
NETEASE = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com"}


def fast_poll():
    w = settings["widgets"]
    return "lyrics" in w or "notch" in w or (settings["now_lyrics"] and "widget" in w)


async def cached(key, ttl, fn):
    hit = cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        value = await fn()
    except Exception:
        log.exception("%s failed", key)
        if hit:
            return hit[1]
        raise HTTPException(502, f"{key} unavailable")
    cache[key] = (time.time(), value)
    return value


@router.get("/settings")
async def get_settings():
    return settings | {"client_id": spotify.cfg.get("client_id", ""), "redirect": spotify.REDIRECT}


@router.put("/settings")
async def put_settings(new: dict = Body(...)):
    if new.get("client_id", "").strip() and new["client_id"].strip() != spotify.cfg.get("client_id"):
        spotify.set_client_id(new["client_id"])
    new = {k: v for k, v in new.items() if k in DEFAULTS}
    # The Settings page sends everything on each change, so a city, key or ID that doesn't check out keeps its old value
    # and only that is reported (as `warning`): the rest still saves.
    warning = None
    for k in ("city", "lastfm_user", "lastfm_key", "steam_key", "steam_id"):
        if k in new:
            new[k] = str(new[k] or "").strip()
    city = new.get("city", settings["city"])
    if not city:
        new |= {"city": "", "lat": None, "lon": None, "place": ""}
    elif city != settings["city"] or settings["lat"] is None:
        try:
            r = await http.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": city, "count": 1})
            hit = (r.json().get("results") or [None])[0]
        except (httpx.HTTPError, ValueError):
            hit, warning = None, "Couldn't reach the weather service, so the city wasn't changed"
        if hit:
            new |= {"lat": hit["latitude"], "lon": hit["longitude"], "place": hit["name"]}
        else:
            new["city"] = settings["city"]
            warning = warning or f"City not found: {city}"
    lf = (new.get("lastfm_user", settings["lastfm_user"]), new.get("lastfm_key", settings["lastfm_key"]))
    lf_changed = lf != (settings["lastfm_user"], settings["lastfm_key"]) and all(lf)
    if lf_changed:
        import lastfm
        try:
            await lastfm.check(*lf)
        except lastfm.LastfmError as e:
            new |= {"lastfm_user": settings["lastfm_user"], "lastfm_key": settings["lastfm_key"]}
            lf_changed, warning = False, f"Last.fm: {e}"
    st = (new.get("steam_key", settings["steam_key"]), new.get("steam_id", settings["steam_id"]))
    if st != (settings["steam_key"], settings["steam_id"]) and st[0]:
        import steam
        try:
            await steam.check(st[0], st[1] or steam.detect_id())
            steam.forget()
        except Exception as e:
            new |= {"steam_key": settings["steam_key"], "steam_id": settings["steam_id"]}
            warning = ("Couldn't reach Steam, try again" if not isinstance(e, steam.SteamError)
                       else "Steam doesn't accept this API key" if str(e) == "key" else "Steam profile not found, check the SteamID")
    settings.update(new)
    write_json(FILE, settings, 2)
    if lf_changed:
        lastfm.start()
    cache.clear()
    return await get_settings() | ({"warning": warning} if warning else {})


def parse_lrc(text):
    out = []
    for line in (text or "").splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", line)
        words = re.sub(r"\[[^\]]*\]", "", line).strip()
        out += [[int((int(m) * 60 + float(s)) * 1000), words] for m, s in stamps]
    return sorted(out)


async def lrclib(name, artist, album, secs):
    q = {"track_name": name, "artist_name": artist}
    r = await http.get("https://lrclib.net/api/get", params=q | {"album_name": album or "", "duration": secs})
    if r.status_code != 404:
        r.raise_for_status()
    hit = r.json() if r.status_code == 200 else {}
    if not hit.get("syncedLyrics"):
        r = (await http.get("https://lrclib.net/api/search", params=q)).raise_for_status()
        found = r.json() if isinstance(r.json(), list) else []
        hit = next((x for x in found if x.get("syncedLyrics")), hit or (found[0] if found else {}))
    return hit.get("syncedLyrics") or "", hit.get("plainLyrics") or ""


async def netease(name, artist, secs):
    r = await http.get("https://music.163.com/api/search/get", params={"s": f"{name} {artist}", "type": 1, "limit": 8}, headers=NETEASE)
    norm = lambda x: re.sub(r"\W+", "", re.sub(r"\s*[(\[-].*$", "", x).lower())[:12]
    songs = (r.json().get("result") or {}).get("songs") or []
    song = next((x for x in songs if norm(x["name"]) == norm(name) and abs(x["duration"] / 1000 - secs) < 4), None)
    if not song:
        return ""
    r = await http.get("https://music.163.com/api/song/lyric", params={"id": song["id"], "lv": 1}, headers=NETEASE)
    lrc = (r.json().get("lrc") or {}).get("lyric") or ""
    return "\n".join(l for l in lrc.splitlines() if not CREDIT.match(re.sub(r"\[[^\]]*\]", "", l).strip()))


async def ovh(name, artist):
    r = await http.get(f"https://api.lyrics.ovh/v1/{quote(artist)}/{quote(name)}", timeout=10)
    if r.status_code != 404:
        r.raise_for_status()
    return (r.json().get("lyrics") or "").strip() if r.status_code == 200 else ""


async def safe(coro, default, failed):
    try:
        return await coro
    except Exception as e:
        log.warning("Lyrics source failed: %s: %s", type(e).__name__, e)
        failed.append(e)
        return default


RECHECK = 14 * 86400  # songs with no lyrics anywhere are looked up again after two weeks


@router.get("/lyrics")
async def lyrics(id: str):
    row = db.execute("SELECT synced, plain, source, checked FROM lyrics WHERE track_id=?", (id,)).fetchone()
    if not row or (not row[0] and (row[2] is None or (not row[1] and not row[2] and (row[3] or 0) < time.time() - RECHECK))):
        t = db.execute("SELECT t.name, al.name, t.duration_ms, (SELECT ar.name FROM track_artists ta JOIN artists ar "
                       "ON ar.id = ta.artist_id WHERE ta.track_id = t.id ORDER BY ta.position LIMIT 1) "
                       "FROM tracks t LEFT JOIN albums al ON al.id = t.album_id WHERE t.id=?", (id,)).fetchone()
        c = poller.cur and poller.cur["track"]
        if c and c["id"] == id:
            t = (c["name"], c["album"]["name"], c["duration_ms"], c["artists"][0]["name"])
        if not t:
            raise HTTPException(404, "Unknown track")
        name, album, ms, artist = t
        secs = round((ms or 0) / 1000)
        failed = []
        synced, plain = await safe(lrclib(name, artist, album, secs), ("", ""), failed)
        source = "lrclib" if synced or plain else ""
        if not synced and (s := await safe(netease(name, artist, secs), "", failed)):
            synced, source = s, "netease"
        if not synced and not plain and (p := await safe(ovh(name, artist), "", failed)):
            plain, source = p, "lyrics.ovh"
        # Nothing found because a source was down: don't remember that, ask again next time.
        row = (synced, plain, None if failed and not (synced or plain) else source)
        db.execute("INSERT OR REPLACE INTO lyrics (track_id, synced, plain, source, checked) VALUES (?,?,?,?,?)", (id, *row, int(time.time())))
    return {"id": id, "lines": parse_lrc(row[0]), "plain": row[1], "source": row[2]}


@router.get("/calendar")
async def calendar():
    start = datetime.combine(date.today(), datetime.min.time())
    out = []
    for url in settings["calendars"]:
        url = re.sub(r"^webcal://", "https://", url.strip(), flags=re.I)
        try:  # one link that's down or isn't a calendar (a login page) only drops that calendar
            cal = icalendar.Calendar.from_ical(await cached(url, 900, lambda u=url: fetch(u)))
            name = str(cal.get("X-WR-CALNAME", ""))
            for e in recurring_ical_events.of(cal).between(start, start + timedelta(days=14)):
                s, end = e["DTSTART"].dt, e.get("DTEND", e["DTSTART"]).dt
                day = not isinstance(s, datetime)
                out.append({"title": str(e.get("SUMMARY", "")), "start": local(s).isoformat(), "end": local(end).isoformat(),
                            "all_day": day, "calendar": name})
        except Exception as e:
            log.warning("Calendar %s skipped: %s: %s", url[:60], type(e).__name__, e)
    return sorted(out, key=lambda e: e["start"])[:20]


def local(d):
    return d.astimezone().replace(tzinfo=None) if isinstance(d, datetime) and d.tzinfo else d


async def fetch(url):
    r = await http.get(url)
    r.raise_for_status()
    return r.content


async def icloud():
    guid = settings["album"].strip().rstrip("/").split("/")[-1].split("#")[-1]
    hdr = {"Content-Type": "text/plain;charset=UTF-8", "Origin": "https://photos.icloud.com"}
    r = (await http.post("https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve",
                         content=json.dumps({"shortGUIDs": [{"value": guid}]}), headers=hdr)).json()["results"][0]
    access = r["anonymousPublicAccess"]
    url = (access["databasePartition"].removesuffix(":443") + "/database/1/com.apple.photos.cloud/production/shared/records/query")
    photos, marker = [], None
    while True:
        body = {"query": {"recordType": "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
                          "filterBy": [{"fieldName": "direction", "comparator": "EQUALS", "fieldValue": {"value": "DESCENDING", "type": "STRING"}}]},
                "zoneID": r["zoneID"], "resultsLimit": 200, "desiredKeys": ["resJPEGMedRes"]}
        if marker:
            body["continuationMarker"] = marker
        res = (await http.post(url, params={"publicAccessAuthToken": access["token"]}, content=json.dumps(body), headers=hdr)).json()
        for rec in res.get("records", []):
            dl = rec.get("fields", {}).get("resJPEGMedRes", {}).get("value", {}).get("downloadURL")
            if rec.get("recordType") == "CPLMaster" and dl:
                photos.append((rec["recordName"], dl.replace("${f}", "photo.jpg")))
        marker = res.get("continuationMarker")
        if not marker or len(photos) >= 2000:
            return photos


def photo_key(key):
    return hashlib.sha1(key.encode()).hexdigest()


def folder_photos(folder):
    files = [p for p in folder.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")][:5000]
    return {photo_key(str(p)): p for p in files}


async def photo_list():
    """Photo key -> file path or download link. Photos are asked for by key, so a list that changed in between
    (a refreshed album, a new file in the folder) never shows the wrong one."""
    if settings["album"]:
        return await cached("album", 1800, lambda: icloud_map())
    folder = Path(settings["folder"]) if settings["folder"] else None
    if folder and folder.is_dir():
        return await cached(f"folder:{folder}", 300, lambda: asyncio.to_thread(folder_photos, folder))
    return {}


async def icloud_map():
    return {photo_key(k): url for k, url in await icloud()}


@router.get("/photos")
async def photos():
    order = list(await photo_list())
    random.shuffle(order)
    return {"order": order, "seconds": settings["photo_seconds"]}


@router.get("/photo/{key}")
async def photo(key: str):
    src = (await photo_list()).get(key)
    if not src:
        raise HTTPException(404)
    out = CACHE / (key + ".jpg")
    if not out.exists():
        raw = src.read_bytes() if isinstance(src, Path) else await fetch(src)

        def shrink():
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
            im.thumbnail((720, 720))
            im.save(out, "JPEG", quality=86)

        await asyncio.to_thread(shrink)
    return FileResponse(out, headers={"Cache-Control": "max-age=86400"})


@router.get("/weather")
async def weather():
    if settings["lat"] is None:
        return None

    async def load():
        p = {"latitude": settings["lat"], "longitude": settings["lon"], "timezone": "auto", "forecast_hours": 7,
             "current": "temperature_2m,weather_code,is_day", "hourly": "temperature_2m,weather_code,is_day",
             "daily": "weather_code,temperature_2m_max,temperature_2m_min", "forecast_days": 6}
        if settings["fahrenheit"]:
            p["temperature_unit"] = "fahrenheit"
        r = await http.get("https://api.open-meteo.com/v1/forecast", params=p)
        r.raise_for_status()
        w = r.json()
        h = w["hourly"]
        return {"place": settings["place"], "temp": round(w["current"]["temperature_2m"]), "code": w["current"]["weather_code"],
                "day": w["current"]["is_day"], "high": round(w["daily"]["temperature_2m_max"][0]),
                "low": round(w["daily"]["temperature_2m_min"][0]),
                "hours": [{"time": t[11:13], "temp": round(v), "code": c, "day": d}
                          for t, v, c, d in zip(h["time"], h["temperature_2m"], h["weather_code"], h["is_day"])][1:7],
                "days": [{"date": t, "code": c, "high": round(hi), "low": round(lo)} for t, c, hi, lo in
                         zip(*(w["daily"][k] for k in ("time", "weather_code", "temperature_2m_max", "temperature_2m_min")))][1:6]}

    return await cached(f"weather{settings['lat']},{settings['lon']},{settings['fahrenheit']}", 900, load)


class WinGpu:
    """GPU use from Windows' own counters (the 3D graph in Task Manager), for AMD and Intel cards too. No temperature."""

    class Item(ctypes.Structure):
        _fields_ = [("name", ctypes.c_wchar_p), ("status", ctypes.c_uint32), ("pad", ctypes.c_uint32), ("value", ctypes.c_double)]

    def __init__(self):
        pdh = self.pdh = ctypes.windll.pdh
        for f in ("PdhOpenQueryW", "PdhAddEnglishCounterW", "PdhCollectQueryData", "PdhGetFormattedCounterArrayW"):
            getattr(pdh, f).restype = ctypes.c_uint32
        pdh.PdhOpenQueryW.argtypes = [ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
        pdh.PdhAddEnglishCounterW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
        pdh.PdhCollectQueryData.argtypes = [ctypes.c_void_p]
        pdh.PdhGetFormattedCounterArrayW.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32),
                                                     ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        self.q, self.c = ctypes.c_void_p(), ctypes.c_void_p()
        path = "\\GPU Engine(*engtype_3D)\\Utilization Percentage"
        if pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.q)) or pdh.PdhAddEnglishCounterW(self.q, path, 0, ctypes.byref(self.c)):
            raise OSError("no GPU counters")
        pdh.PdhCollectQueryData(self.q)

    def read(self):
        size, count = ctypes.c_uint32(0), ctypes.c_uint32(0)
        if self.pdh.PdhCollectQueryData(self.q):
            return None
        self.pdh.PdhGetFormattedCounterArrayW(self.c, 0x200, ctypes.byref(size), ctypes.byref(count), None)  # PDH_FMT_DOUBLE
        if not size.value:
            return 0
        buf = ctypes.create_string_buffer(size.value)
        if self.pdh.PdhGetFormattedCounterArrayW(self.c, 0x200, ctypes.byref(size), ctypes.byref(count), buf):
            return None
        items = ctypes.cast(buf, ctypes.POINTER(self.Item))
        return min(100, round(sum(items[i].value for i in range(count.value) if items[i].status in (0, 1))))


def find_gpu():
    try:
        import pynvml
        pynvml.nvmlInit()
        return "nvml", (pynvml, pynvml.nvmlDeviceGetHandleByIndex(0))
    except Exception:
        pass
    try:
        return "win", WinGpu()
    except Exception:
        return False


gpu = None
net = (time.time(), psutil.net_io_counters())


@router.get("/system")
async def system():
    global gpu, net
    if gpu is None:
        gpu = find_gpu()
    now, io_ = time.time(), psutil.net_io_counters()
    dt = max(now - net[0], 0.5)
    down, up = (io_.bytes_recv - net[1].bytes_recv) / dt, (io_.bytes_sent - net[1].bytes_sent) / dt
    net = (now, io_)
    ram = psutil.virtual_memory()
    out = {"cpu": psutil.cpu_percent(None), "ram": ram.percent, "ram_used": ram.used / 2**30, "ram_total": ram.total / 2**30,
           "down": down, "up": up, "gpu": None, "gpu_temp": None}
    if gpu and gpu[0] == "nvml":
        nv, h = gpu[1]
        out |= {"gpu": nv.nvmlDeviceGetUtilizationRates(h).gpu, "gpu_temp": nv.nvmlDeviceGetTemperature(h, 0)}
    elif gpu:
        out["gpu"] = gpu[1].read()
    return out
