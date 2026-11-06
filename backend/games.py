import calendar
import ctypes
import time
from collections import defaultdict
from ctypes import wintypes
from datetime import datetime

import psutil
from fastapi import APIRouter

from api import ARTISTS, R, Range, q, span
from db import db

router = APIRouter()
db.executescript("""
CREATE TABLE IF NOT EXISTS game_sessions (id INTEGER PRIMARY KEY, exe TEXT, title TEXT, start REAL, end REAL);
CREATE INDEX IF NOT EXISTS game_end ON game_sessions (end);
""")
if db.execute("SELECT 1 FROM sqlite_master WHERE name = 'games'").fetchone():
    db.execute("INSERT INTO game_sessions (exe, title, start, end) SELECT exe, title, unixepoch('now') - seconds, unixepoch('now') FROM games")
    db.execute("DROP TABLE games")
SKIP = {"explorer.exe", "brave.exe", "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "vlc.exe", "spotify.exe",
        "spotify-stats.exe", "wavelog.exe", "wavelog-logger.exe", "code.exe", "obs64.exe", "applicationframehost.exe", "lockapp.exe", "searchhost.exe",
        "shellexperiencehost.exe", "startmenuexperiencehost.exe", "mpc-hc64.exe", "potplayermini64.exe", "discord.exe"}
EVERY = 15


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


u = ctypes.windll.user32
u.GetForegroundWindow.restype = wintypes.HWND
u.MonitorFromWindow.restype = wintypes.HANDLE
u.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
u.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]


def game():
    h = u.GetForegroundWindow()
    if not h:
        return None
    r, mi = wintypes.RECT(), MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    u.GetWindowRect(h, ctypes.byref(r))
    u.GetMonitorInfoW(u.MonitorFromWindow(h, 2), ctypes.byref(mi))
    m = mi.rcMonitor
    if not (r.left <= m.left and r.top <= m.top and r.right >= m.right and r.bottom >= m.bottom):
        return None
    pid = wintypes.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    try:
        exe = psutil.Process(pid.value).name()
    except psutil.Error:
        return None
    buf = ctypes.create_unicode_buffer(128)
    u.GetWindowTextW(h, buf, 128)
    title = buf.value.strip()
    return None if exe.lower() in SKIP else (exe, title if 0 < len(title) < 40 else exe.removesuffix(".exe"))


async def track():
    if not (g := game()):
        return
    now = time.time()
    row = db.execute("SELECT id, exe, end FROM game_sessions ORDER BY id DESC LIMIT 1").fetchone()
    if row and row[1] == g[0] and now - row[2] < EVERY * 3:
        db.execute("UPDATE game_sessions SET end = ?, title = ? WHERE id = ?", (now, g[1], row[0]))
    else:
        db.execute("INSERT INTO game_sessions (exe, title, start, end) VALUES (?,?,?,?)", (*g, now - EVERY, now))


def epoch(t):
    return {"0": 0, "9": 1e11}.get(t) or calendar.timegm(datetime.strptime(t, "%Y-%m-%d %H:%M:%S").timetuple())


@router.get("/gaming")
async def gaming(r: Range = R, year: int = None, limit: int = 10):
    a, b = map(epoch, span(r, year))
    rows = db.execute("SELECT exe, title, max(start, ?), min(end, ?) FROM game_sessions WHERE end > ? AND start < ? ORDER BY start",
                      (a, b, a, b)).fetchall()
    games, days, hours, heat = {}, defaultdict(int), [0] * 24, [[0] * 24 for _ in range(7)]
    for exe, title, s, e in rows:
        g = games.setdefault(exe, {"exe": exe, "name": title, "seconds": 0, "sessions": 0, "longest": 0, "days": set(), "last": 0})
        g.update(name=title, seconds=g["seconds"] + e - s, sessions=g["sessions"] + 1, longest=max(g["longest"], e - s), last=e)
        t = s
        while t < e:
            nxt = min(e, (t // 3600 + 1) * 3600)
            d = datetime.fromtimestamp(t)
            days[str(d.date())] += nxt - t
            hours[d.hour] += nxt - t
            heat[d.weekday()][d.hour] += nxt - t
            g["days"].add(d.date())
            t = nxt
    out = sorted(games.values(), key=lambda g: -g["seconds"])
    for g in out:
        g.update(minutes=round(g.pop("seconds") / 60), longest=round(g["longest"] / 60), days=len(g["days"]),
                 last=str(datetime.fromtimestamp(g["last"]))[:16])
    longest = max(rows, key=lambda x: x[3] - x[2], default=None)
    return {
        "games": out, "minutes": sum(g["minutes"] for g in out), "sessions": len(rows),
        "longest": longest and {"name": longest[1], "minutes": round((longest[3] - longest[2]) / 60),
                                "day": str(datetime.fromtimestamp(longest[2]).date())},
        "days": [{"day": k, "minutes": round(v / 60)} for k, v in sorted(days.items())],
        "hours": [{"hour": h, "minutes": round(v / 60)} for h, v in enumerate(hours)],
        "heat": [[round(v / 60) for v in row] for row in heat],
        "soundtrack": q(f"SELECT t.id, t.name, {ARTISTS} AS artists, al.image_url AS image, count(*) AS plays, "
                        "sum(p.ms_played) / 60000 AS minutes FROM plays p JOIN tracks t ON t.id = p.track_id "
                        "LEFT JOIN albums al ON al.id = t.album_id WHERE EXISTS (SELECT 1 FROM game_sessions g "
                        "WHERE g.end >= unixepoch(p.played_at) - 30 AND g.start <= unixepoch(p.played_at)) AND unixepoch(p.played_at) BETWEEN ? AND ? "
                        "GROUP BY t.id ORDER BY plays DESC, minutes DESC LIMIT ?", a, b, limit),
    }
