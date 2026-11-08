"""Steam: recent games and playtime, newest achievements, and which friends are online or in a game.

Uses the Steam Web API with the user's own key (steamcommunity.com/dev/apikey) and their SteamID64, which is read from
the Steam client on this PC when it isn't set. Friends and achievements need those parts of the profile to be public.
"""
import asyncio
import re
import time
import winreg
from pathlib import Path

from fastapi import APIRouter, HTTPException

from widgets import http, settings

router = APIRouter()
API = "https://api.steampowered.com/"
cache = {}  # own cache, so saving settings doesn't throw away achievement lookups


class SteamError(Exception):
    pass


def detect_id():
    """SteamID64 of the account logged in to Steam on this PC, or ""."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam\ActiveProcess") as k:
            account = winreg.QueryValueEx(k, "ActiveUser")[0]
        if account:
            return str(76561197960265728 + account)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            path = Path(winreg.QueryValueEx(k, "SteamPath")[0])
        users = (path / "config" / "loginusers.vdf").read_text(encoding="utf-8", errors="ignore")
        blocks = re.findall(r'"(7656\d{13})"\s*\{([^}]*)\}', users)
        recent = [sid for sid, body in blocks if re.search(r'"MostRecent"\s*"1"', body)]
        return (recent or [sid for sid, _ in blocks] or [""])[0]
    except OSError:
        return ""


async def call(path, key, **params):
    r = await http.get(API + path, params={"key": key, "format": "json", **params}, timeout=20)
    if r.status_code in (401, 403):
        raise SteamError("private" if "Friend" in path or "Achievement" in path else "key")
    r.raise_for_status()
    return r.json()


async def kept(name, ttl, fn):
    hit = cache.get(name)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        value = await fn()
    except Exception:
        if hit:
            return hit[1]
        raise
    cache[name] = (time.time(), value)
    return value


async def check(key, sid):
    """Raises SteamError if the key or SteamID is wrong. Returns the profile name."""
    players = (await call("ISteamUser/GetPlayerSummaries/v2/", key, steamids=sid))["response"]["players"]
    if not players:
        raise SteamError("id")
    return players[0]["personaname"]


def person(p):
    return {"id": p["steamid"], "name": p.get("personaname", ""), "avatar": p.get("avatarmedium"), "game": p.get("gameextrainfo"),
            "online": p.get("personastate", 0) > 0}


async def friends(key, sid):
    try:
        ids = [f["steamid"] for f in (await call("ISteamUser/GetFriendList/v1/", key, steamid=sid, relationship="friend"))["friendslist"]["friends"]]
    except SteamError:
        return None  # friends list is private
    out = []
    for i in range(0, len(ids), 100):
        out += [person(p) for p in (await call("ISteamUser/GetPlayerSummaries/v2/", key, steamids=",".join(ids[i:i + 100])))["response"]["players"]]
    on = [f for f in out if f["online"]]
    return sorted(on, key=lambda f: (not f["game"], f["name"].lower()))


def community_img(appid, name):
    """Game and achievement icons. Steam's old image hosts (media.steampowered.com, steamcdn-a) now return 404."""
    if not name:
        return None
    name = name.rsplit("/", 1)[-1]
    return f"https://shared.akamai.steamstatic.com/community_assets/images/apps/{appid}/{name if '.' in name else name + '.jpg'}"


async def header(appid):
    """Store header image. Newer games keep it under a hashed path, so ask the store for it."""
    async def look():
        r = await http.get("https://store.steampowered.com/api/appdetails", params={"appids": appid, "filters": "basic"}, timeout=20)
        return ((r.json().get(str(appid)) or {}).get("data") or {}).get("header_image")
    try:
        return await kept(f"header{appid}", 7 * 86400, look)
    except Exception:
        return None


async def recent(key, sid):
    games = (await call("IPlayerService/GetRecentlyPlayedGames/v1/", key, steamid=sid, count=8))["response"].get("games", [])
    heads = await asyncio.gather(*(header(g["appid"]) for g in games))
    return [{"appid": g["appid"], "name": g.get("name", ""), "hours_2w": round(g.get("playtime_2weeks", 0) / 60, 1),
             "hours": round(g.get("playtime_forever", 0) / 60), "header": h, "icon": community_img(g["appid"], g.get("img_icon_url"))}
            for g, h in zip(games, heads)]


async def achievements(key, sid, games):
    """Newest unlocked achievements across the recently played games."""
    async def one(g):
        try:
            stats = (await call("ISteamUserStats/GetPlayerAchievements/v1/", key, steamid=sid, appid=g["appid"], l="english"))["playerstats"]
        except (SteamError, Exception):
            return []
        got = [a for a in stats.get("achievements", []) if a.get("achieved")]
        if not got:
            return []
        schema = await kept(f"schema{g['appid']}", 86400, lambda: call("ISteamUserStats/GetSchemaForGame/v2/", key, appid=g["appid"], l="english"))
        icons = {a["name"]: a.get("icon") for a in ((schema.get("game") or {}).get("availableGameStats") or {}).get("achievements", [])}
        return [{"game": g["name"], "name": a.get("name") or a["apiname"], "desc": a.get("description", ""),
                 "icon": community_img(g["appid"], icons.get(a["apiname"])),
                 "at": a.get("unlocktime", 0)} for a in got]

    found = [a for part in await asyncio.gather(*(one(g) for g in games[:4])) for a in part]
    return sorted(found, key=lambda a: -a["at"])[:6]


@router.get("/steam")
async def steam():
    key, sid = settings.get("steam_key"), settings.get("steam_id") or detect_id()
    if not key:
        return {"connected": False, "steam_id": sid}
    try:
        me = await kept("me", 60, lambda: call("ISteamUser/GetPlayerSummaries/v2/", key, steamids=sid))
        games = await kept("recent", 600, lambda: recent(key, sid))
        fr = await kept("friends", 60, lambda: friends(key, sid))
        ach = await kept("ach", 1800, lambda: achievements(key, sid, games))
    except SteamError as e:
        return {"connected": True, "error": "Steam doesn't accept this API key" if str(e) == "key" else "Steam profile not found"}
    except Exception:
        return {"connected": True, "error": "Couldn't reach Steam, will retry"}
    players = me["response"]["players"]
    return {"connected": True, "me": person(players[0]) if players else None, "recent": games, "friends": fr, "achievements": ach,
            "private": fr is None}


@router.get("/steam/detect")
async def detect():
    return {"steam_id": detect_id()}


def forget():
    cache.clear()
