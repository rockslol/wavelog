"""Discord status: "Listening to <song>" with the cover, artist and your play count, over Discord's local IPC pipe.

Discord reads Rich Presence from \\\\.\\pipe\\discord-ipc-N. Frames are an 8-byte header (opcode, length, little-endian)
plus JSON: a handshake with Wavelog's Discord application id, then SET_ACTIVITY commands. Discord allows about
5 updates per 20 s, so this only sends when the song, play state or position changes.
"""
import asyncio
import json
import os
import struct
import threading
import time
import uuid
from datetime import datetime

from fastapi import APIRouter

import poller
from widgets import settings

router = APIRouter()
CLIENT_ID = ""  # built-in Wavelog application (Discord developer portal); its name is what Discord shows


def app_id():
    """The Application ID from Settings, else the built-in one."""
    return "".join(ch for ch in str(settings.get("discord_app") or "") if ch.isdigit()) or CLIENT_ID
ICON = "https://raw.githubusercontent.com/rockslol/wavelog/main/app/src-tauri/icons/128x128.png"
state = {"app": None, "connected": False, "error": None, "shown": None, "at": 0.0, "retry": 0.0, "plays": {}}
lock = threading.Lock()


class Pipe:
    f = None

    def connect(self):
        for i in range(10):
            try:
                f = open(rf"\\.\pipe\discord-ipc-{i}", "r+b", buffering=0)
            except OSError:
                continue
            self.f = f
            try:
                self.send(0, {"v": 1, "client_id": app_id()})
                op, data = self.recv()
            except OSError:
                self.close()
                continue
            if op == 1 and data.get("evt") == "READY":
                return True
            self.close()
            raise RuntimeError(data.get("message") or "Discord refused the connection")
        return False

    def send(self, op, payload):
        body = json.dumps(payload).encode()
        self.f.write(struct.pack("<II", op, len(body)) + body)

    def recv(self):
        head = self.f.read(8)
        if len(head) < 8:
            raise OSError("Discord closed the pipe")
        op, n = struct.unpack("<II", head)
        return op, json.loads(self.f.read(n) or b"{}")

    def close(self):
        try:
            self.f and self.f.close()
        except OSError:
            pass
        self.f = None


pipe = Pipe()


def command(activity):
    """Blocking: connect if needed, set (or clear, with None) the activity. Runs in a worker thread."""
    with lock:
        if not pipe.f and not pipe.connect():
            raise OSError("Discord isn't running")
        try:
            pipe.send(1, {"cmd": "SET_ACTIVITY", "args": {"pid": os.getpid(), "activity": activity}, "nonce": str(uuid.uuid4())})
            op, data = pipe.recv()
        except OSError:
            pipe.close()
            raise
        if data.get("evt") == "ERROR":
            raise RuntimeError(data.get("data", {}).get("message", "Discord didn't accept the status"))


def text(s, n=128):
    s = (s or "").strip()
    return (s + "  ")[:max(2, min(len(s), n))]  # Discord wants 2 to 128 characters


async def gaming():
    """The game you're in, for the line under the artist: "Playing Nomad Drive", or Valorant's mode, map and agent.
    Game sessions are saved every 15 s while a game is in front; after 90 s without one, you're done."""
    import valorant
    from db import db
    row = db.execute("SELECT exe, title, end FROM game_sessions ORDER BY id DESC LIMIT 1").fetchone()
    if not row or time.time() - row[2] > 90:
        return None
    exe, title, _ = row
    if not exe.lower().startswith("valorant"):
        return f"Playing {title}"
    lv = valorant.live_cache.get("data") if settings.get("valorant") else None
    if not lv:
        return "Playing Valorant"
    if lv["state"] == "PREGAME":
        return " · ".join(x for x in ("Valorant agent select", lv["map"]) if x)
    agent = (await valorant.safe_assets())["agents"].get(lv.get("agent_id") or "", {}).get("name")
    where = " on ".join(x for x in (lv["mode"], lv["map"]) if x)
    return "In Valorant" + (f" · {where}" if where else "") + (f" as {agent}" if agent else "")


async def activity(c):
    import api
    t = c["track"]
    name, artists = t["name"], ", ".join(a["name"] for a in t["artists"])
    start = int(time.time() * 1000 - c["progress"] - ((time.time() - c["poll"]) * 1000 if c["playing"] else 0))
    a = {
        "type": 2,  # Listening
        "status_display_type": 2,  # the member list says "Listening to <song>", not the app's name
        "details": text(name), "state": text(artists),
        "timestamps": {"start": start, "end": start + t["duration_ms"]},
        "assets": {"large_image": (t["album"].get("images") or [{}])[0].get("url"), "large_text": text(await gaming() or t["album"]["name"])},
        "buttons": [{"label": "Play on Spotify", "url": f"https://open.spotify.com/track/{t['id']}"}],
    }
    if settings.get("discord_plays", True):
        if t["id"] not in state["plays"]:  # same count as the notch badge: this song in any version
            state["plays"] = {t["id"]: await api.song_plays(t["id"], name, artists)}
        p = state["plays"][t["id"]]
        since = datetime.fromisoformat(p["first"]).strftime(" · since %b %Y") if p["first"] else " · first listen"
        a["assets"].update(small_image=ICON, small_text=f"Play #{p['plays'] + 1}{since}")
    return a


async def tick():
    """Every 2 s: show the song while it plays, clear it when paused or turned off."""
    want = bool(settings.get("discord")) and bool(app_id())
    if state["app"] != app_id():  # a new Application ID: start over with it
        state.update(app=app_id(), shown=None, retry=0.0, error=None, connected=False)
        await asyncio.to_thread(pipe.close)
    c = poller.cur
    playing = want and c and c["playing"]
    if playing:
        act = await activity(c)
        key = (c["track"]["id"], act["timestamps"]["start"], act["assets"]["large_text"])
    else:
        act, key = None, None
    shown = state["shown"]
    same = key == shown or (key and shown and key[0::2] == shown[0::2] and abs(key[1] - shown[1]) < 3000)  # seeking 3 s+ is a change
    if same and not (key and time.time() - state["at"] > 60):  # resend a minute later in case Discord restarted
        return
    if time.time() < state["retry"] or time.time() - state["at"] < 4:  # Discord's rate limit
        return
    state["at"] = time.time()
    try:
        await asyncio.to_thread(command, act)
        state.update(connected=True, error=None, shown=key)
        if not want:
            await asyncio.to_thread(pipe.close)
            state["connected"] = False
    except Exception as e:
        state.update(connected=False, error=str(e), shown=None, retry=time.time() + 15)


@router.get("/discord")
async def status():
    return {"enabled": bool(settings.get("discord")), "ready": bool(app_id()), "connected": state["connected"],
            "showing": bool(state["shown"]), "error": state["error"]}
