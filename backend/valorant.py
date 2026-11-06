import asyncio
import base64
import json
import logging
import os
import re
import time
from collections import defaultdict
from pathlib import Path

import httpx
from fastapi import APIRouter

from api import ARTISTS, q
from db import DATA, db
from widgets import cached, http, settings

router = APIRouter()
log = logging.getLogger("valorant")
LOCAL = Path(os.environ["LOCALAPPDATA"])
LOCKFILE = LOCAL / "Riot Games" / "Riot Client" / "Config" / "lockfile"
GAMELOG = LOCAL / "VALORANT" / "Saved" / "Logs" / "ShooterGame.log"
PLATFORM = base64.b64encode(json.dumps({"platformType": "PC", "platformOS": "Windows", "platformOSVersion": "10.0.19042.1.256.64bit",
                                        "platformChipset": "Unknown"}).encode()).decode()
QUEUES = {"competitive": "Competitive", "unrated": "Unrated", "swiftplay": "Swiftplay", "spikerush": "Spike Rush",
          "deathmatch": "Deathmatch", "ggteam": "Escalation", "hurm": "Team Deathmatch", "premier": "Premier",
          "skirmish2v2": "Skirmish", "abilitydraftarena": "Ability Draft", "": "Custom"}
db.execute("""CREATE TABLE IF NOT EXISTS val_matches (id TEXT PRIMARY KEY, puuid TEXT, started_at INTEGER, length INTEGER, map TEXT,
    map_id TEXT, mode TEXT, agent TEXT, agent_id TEXT, won INTEGER, rounds_won INTEGER, rounds_lost INTEGER, kills INTEGER,
    deaths INTEGER, assists INTEGER, score INTEGER, headshots INTEGER, shots INTEGER, damage INTEGER, rounds INTEGER,
    rr INTEGER, tier INTEGER)""")
try:
    db.execute("ALTER TABLE val_matches ADD COLUMN round_data TEXT")
except Exception:
    pass
db.execute("UPDATE val_matches SET round_data = NULL WHERE mode = 'Abilitydraftarena'")
local = httpx.AsyncClient(verify=False, timeout=10)
CACHE = DATA / "valorant.json"
state = json.loads(CACHE.read_text()) if CACHE.exists() else {}
lock = asyncio.Lock()


async def assets():
    async def load():
        get = lambda path, **p: http.get("https://valorant-api.com/v1/" + path, params=p)
        tiers, agents, maps, version = await asyncio.gather(get("competitivetiers"), get("agents", isPlayableCharacter="true"),
                                                            get("maps"), get("version"))
        return {"tiers": {t["tier"]: {"name": t["tierName"].title(), "icon": t["largeIcon"]} for t in tiers.json()["data"][-1]["tiers"]},
                "agents": {a["uuid"].lower(): {"name": a["displayName"], "icon": a["displayIcon"]} for a in agents.json()["data"]},
                "maps": {m["mapUrl"]: {"name": m["displayName"], "icon": m["listViewIcon"]} for m in maps.json()["data"]},
                "version": version.json()["data"]["riotClientVersion"]}

    return await cached("val-assets", 86400, load)


async def login():
    _, _, port, password, _ = LOCKFILE.read_text().split(":")
    auth = {"Authorization": "Basic " + base64.b64encode(f"riot:{password}".encode()).decode()}
    t = (await local.get(f"https://127.0.0.1:{port}/entitlements/v1/token", headers=auth)).json()
    me = (await local.get(f"https://127.0.0.1:{port}/chat/v1/session", headers=auth)).json()
    if me.get("game_name"):
        state["riot_id"] = f"{me['game_name']}#{me['game_tag']}"
    log_text = GAMELOG.read_text(errors="ignore") if GAMELOG.exists() else ""
    shard = next(iter(re.findall(r"https://pd\.(\w+)\.a\.pvp\.net", log_text)), None)
    version = next(iter(re.findall(r"CI server version: (\S+)", log_text)), None) or (await assets())["version"]
    if not shard:
        region = (await local.get(f"https://127.0.0.1:{port}/riotclient/region-locale", headers=auth)).json()["region"].lower()
        shard = {"latam": "na", "br": "na"}.get(region, region)
    glz = next(iter(re.findall(r"https://(glz-[\w-]+\.\w+\.a\.pvp\.net)", log_text)), f"glz-{shard}-1.{shard}.a.pvp.net")
    return t["subject"], shard, {"Authorization": "Bearer " + t["accessToken"], "X-Riot-Entitlements-JWT": t["token"],
                                 "X-Riot-ClientPlatform": PLATFORM, "X-Riot-ClientVersion": version}, (port, auth, glz)


def save(m, puuid, a):
    info = m["matchInfo"]
    me = next((p for p in m["players"] if p["subject"] == puuid), None)
    if not me or not me.get("stats"):
        return
    teams = m.get("teams") or []
    team = next((t for t in teams if t["teamId"] == me["teamId"]), None)
    other = next((t for t in teams if t["teamId"] != me["teamId"]), None) if len(teams) == 2 else None
    won = None if not team or (other and team["roundsWon"] == other["roundsWon"]) else int(team["won"])
    hits = [d for r in m.get("roundResults") or [] for p in r.get("playerStats") or [] if p["subject"] == puuid for d in p.get("damage") or []]
    s, agent = me["stats"], a["agents"].get(me["characterId"].lower(), {})
    rounds = []
    for r in m.get("roundResults") or []:
        ps = r.get("playerStats") or []
        kills = sorted((k for p in ps for k in p.get("kills") or []), key=lambda k: k.get("timeSinceRoundStartMillis", 0))
        mine = next((p for p in ps if p["subject"] == puuid), {})
        rounds.append({"won": r.get("winningTeam") == me["teamId"] if r.get("winningTeam") else None, "how": r.get("roundResult", ""),
                       "k": sum(k["killer"] == puuid for k in kills), "dmg": sum(d["damage"] for d in mine.get("damage") or []),
                       "died": any(k["victim"] == puuid for k in kills), "fb": bool(kills) and kills[0]["killer"] == puuid,
                       "fd": bool(kills) and kills[0]["victim"] == puuid, "plant": r.get("bombPlanter") == puuid,
                       "defuse": r.get("bombDefuser") == puuid, "loadout": (mine.get("economy") or {}).get("loadoutValue", 0)})
    db.execute("INSERT OR REPLACE INTO val_matches (id, puuid, started_at, length, map, map_id, mode, agent, agent_id, won, rounds_won, "
               "rounds_lost, kills, deaths, assists, score, headshots, shots, damage, rounds, round_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (info["matchId"], puuid, info["gameStartMillis"], info.get("gameLengthMillis") or 0,
                a["maps"].get(info["mapId"], {}).get("name", info["mapId"].split("/")[-1]), info["mapId"],
                QUEUES.get(info.get("queueID") or "", (info.get("queueID") or "").title()), agent.get("name", "?"), me["characterId"].lower(),
                won, team and team["roundsWon"], other and other["roundsWon"], s["kills"], s["deaths"], s["assists"], s["score"],
                sum(d["headshots"] for d in hits), sum(d["headshots"] + d["bodyshots"] + d["legshots"] for d in hits),
                sum(d["damage"] for d in hits), s.get("roundsPlayed") or 1, json.dumps(rounds, separators=(",", ":"))))


async def sync(force=False):
    if not settings.get("valorant") or lock.locked() or (not force and time.time() - state.get("at", 0) < 90):
        return
    async with lock:
        state["at"] = time.time()
        if not LOCKFILE.exists():
            state["error"] = "Open the Riot Client to update"
            return
        try:
            puuid, shard, hdr, _ = await login()
            pd, a = f"https://pd.{shard}.a.pvp.net", await assets()
            get = lambda path, **p: http.get(pd + path, params=p, headers=hdr)
            history = (await get(f"/match-history/v1/history/{puuid}", endIndex=20)).json()["History"]
            known = {r[0] for r in db.execute("SELECT id FROM val_matches WHERE puuid = ? AND round_data IS NOT NULL", (puuid,))}
            for h in history:
                if h["MatchID"] not in known:
                    r = await get(f"/match-details/v1/matches/{h['MatchID']}")
                    if r.status_code == 200:
                        save(r.json(), puuid, a)
                    await asyncio.sleep(1)
            for u in (await get(f"/mmr/v1/players/{puuid}/competitiveupdates", endIndex=20, queue="competitive")).json()["Matches"]:
                db.execute("UPDATE val_matches SET rr = ?, tier = ? WHERE id = ?", (u["RankedRatingEarned"], u["TierAfterUpdate"], u["MatchID"]))
            mmr = (await get(f"/mmr/v1/players/{puuid}")).json()
            last = mmr.get("LatestCompetitiveUpdate") or {}
            seasons = ((mmr.get("QueueSkills") or {}).get("competitive") or {}).get("SeasonalInfoBySeasonID") or {}
            peak = max((int(t) for s in seasons.values() for t in (s.get("WinsByTier") or {})), default=0)
            state.update(puuid=puuid, error=None, current={"tier": last.get("TierAfterUpdate", 0), "rr": last.get("RankedRatingAfterUpdate", 0),
                                                           "last_change": last.get("RankedRatingEarned", 0)}, peak=peak)
            CACHE.write_text(json.dumps({k: state.get(k) for k in ("puuid", "riot_id", "current", "peak")}))
        except Exception as e:
            log.warning("Valorant sync failed: %r", e)
            state["error"] = "Couldn't reach Riot, will retry"


def in_valorant():
    row = db.execute("SELECT exe, end FROM game_sessions ORDER BY id DESC LIMIT 1").fetchone()
    return bool(row and row[0].lower().startswith("valorant") and time.time() - row[1] < 600)


def totals(rows):
    k, d, shots, rounds = (sum(r[x] or 0 for r in rows) for x in ("kills", "deaths", "shots", "rounds"))
    decided = [r for r in rows if r["won"] is not None]
    return {"games": len(rows), "wins": sum(r["won"] for r in decided), "decided": len(decided),
            "kd": round(k / max(d, 1), 2), "hs": round(100 * sum(r["headshots"] or 0 for r in rows) / max(shots, 1)),
            "adr": round(sum(r["damage"] or 0 for r in rows) / max(rounds, 1)), "acs": round(sum(r["score"] or 0 for r in rows) / max(rounds, 1))}


def grouped(rows, key):
    by = defaultdict(list)
    for r in rows:
        by[r[key]].append(r)
    return sorted(({"name": n, "id": g[0][key + "_id"], **totals(g)} for n, g in by.items()), key=lambda x: -x["games"])


def matches(puuid):
    rows = q("SELECT * FROM val_matches WHERE puuid = ? ORDER BY started_at DESC", puuid)
    for r in rows:
        r["round_list"] = json.loads(r.pop("round_data") or "[]")
    return rows


async def safe_assets():
    try:
        return await assets()
    except Exception:
        return {"tiers": {}, "agents": {}, "maps": {}}


live_cache = {}


async def live_match():
    if not LOCKFILE.exists():
        return None
    if time.time() - live_cache.get("at", 0) < 20:
        return live_cache.get("data")
    live_cache["at"] = time.time()
    puuid, shard, hdr, (port, auth, glz) = await login()
    pres = (await local.get(f"https://127.0.0.1:{port}/chat/v4/presences", headers=auth)).json()["presences"]
    me = next((p for p in pres if p["puuid"] == puuid and p.get("product") == "valorant" and p.get("private")), None)
    m = (json.loads(base64.b64decode(me["private"])).get("matchPresenceData") or {}) if me else {}
    data = None
    if m.get("sessionLoopState") in ("INGAME", "PREGAME"):
        a = await safe_assets()
        data = {"state": m["sessionLoopState"], "map_id": m.get("matchMap", ""), "mode": QUEUES.get(m.get("queueId") or "", (m.get("queueId") or "").title()),
                "map": a["maps"].get(m.get("matchMap", ""), {}).get("name", ""), "agent_id": None}
        if m["sessionLoopState"] == "INGAME":
            r = await http.get(f"https://{glz}/core-game/v1/players/{puuid}", headers=hdr)
            if r.status_code == 200:
                mid = r.json()["MatchID"]
                if live_cache.get("match") != mid:
                    players = (await http.get(f"https://{glz}/core-game/v1/matches/{mid}", headers=hdr)).json()["Players"]
                    live_cache.update(match=mid, agent=next((p["CharacterID"].lower() for p in players if p["Subject"] == puuid), None))
                data["agent_id"] = live_cache["agent"]
    live_cache["data"] = data
    return data


@router.get("/valorant/live")
async def live():
    if not settings.get("valorant"):
        return {"enabled": False}
    try:
        lv = await live_match()
    except Exception as e:
        log.warning("Live match failed: %r", e)
        lv = None
    rows, a = matches(state.get("puuid")), await safe_assets()
    midnight = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)) * 1000
    today = [r for r in rows if r["started_at"] >= midnight]
    pick = lambda key, v: v and totals([r for r in rows if r[key] == v])
    return {"enabled": True, "live": lv, "current": state.get("current"), "assets": a,
            "today": {**totals(today), "rr": sum(r["rr"] or 0 for r in today)},
            "map": pick("map_id", lv and lv["map_id"]), "agent": pick("agent_id", lv and lv["agent_id"]), "last": rows[0] if rows else None}


@router.get("/valorant")
async def valorant():
    if not settings.get("valorant"):
        return {"enabled": False}
    if not state.get("puuid"):
        await sync(force=True)
    puuid = state.get("puuid")
    rows = matches(puuid)
    a = await safe_assets()
    return {
        "enabled": True, "error": state.get("error"), "updated": state.get("at"), "riot_id": state.get("riot_id"),
        "current": state.get("current"), "peak": state.get("peak"), "assets": {k: a[k] for k in ("tiers", "agents", "maps")},
        "all": totals(rows), "competitive": totals([r for r in rows if r["mode"] == "Competitive"]), "matches": rows[:20],
        "agents": grouped(rows, "agent")[:8], "maps": grouped(rows, "map"),
        "songs": q(f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image, count(*) AS games, sum(x.won) AS wins "
                   "FROM (SELECT DISTINCT m.id, m.won, p.track_id FROM val_matches m JOIN plays p ON unixepoch(p.played_at) "
                   "BETWEEN m.started_at / 1000 AND (m.started_at + m.length) / 1000 + 60 WHERE m.puuid = ? AND m.won IS NOT NULL) x "
                   "JOIN tracks t ON t.id = x.track_id LEFT JOIN albums al ON al.id = t.album_id GROUP BY t.id "
                   "ORDER BY 1.0 * sum(x.won) / count(*) DESC, games DESC LIMIT 8", puuid),
    }


@router.post("/valorant/refresh")
async def refresh():
    await sync(force=time.time() - state.get("at", 0) > 30)
    return await valorant()
