import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from db import DATA

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[RotatingFileHandler(DATA / "app.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")],
)
logging.getLogger("httpx").setLevel(logging.WARNING)

import api
import db
import debug
import games
import history
import lastfm
import pcwatch
import poller
import share
import spotify
import steam
import notifs
import plugins
import shelf
import widgets


@asynccontextmanager
async def lifespan(app):
    poller.load_current()
    tasks = [asyncio.create_task(poller.loop(poller.poll_current, lambda: 5 if widgets.fast_poll() else 20)),
             asyncio.create_task(poller.loop(poller.poll_recent, 300)),
             asyncio.create_task(poller.loop(poller.fill_missing, 2)),
             asyncio.create_task(poller.loop(db.backup, 3600)),
             asyncio.create_task(poller.loop(games.track, games.EVERY)),
             asyncio.create_task(poller.loop(lastfm.auto, 1800))]
    await plugins.start_all()
    yield
    poller.save_current()
    await plugins.stop_all()
    for t in tasks:
        t.cancel()


from version import VERSION

app = FastAPI(title="Wavelog", version=VERSION, lifespan=lifespan)
# The app's own pages. The Vite dev server only when running from source: in a release any page on port 1420 (another
# project's dev server) would get the whole API.
ORIGINS = ["tauri://localhost", "http://tauri.localhost"] + ([] if getattr(sys, "frozen", False) else ["http://localhost:1420"])
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def same_app_only(request, call_next):
    """CORS only hides answers; a web page can still send a POST without a body (a "simple request") to 127.0.0.1.
    Browsers always say where such a request comes from, so changes from any other page are refused. The app's
    windows and its own Rust code (no Origin at all) pass."""
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin not in ORIGINS:
        return JSONResponse({"detail": "Not allowed from this page"}, status_code=403)
    return await call_next(request)
app.include_router(api.router)
app.include_router(debug.router)
app.include_router(widgets.router)
app.include_router(share.router)
app.include_router(games.router)
app.include_router(pcwatch.router)
app.include_router(steam.router)
app.include_router(notifs.router)
app.include_router(shelf.router)
app.include_router(plugins.router)
app.include_router(history.router)


@app.get("/login")
async def login():
    return RedirectResponse(spotify.auth_url())


@app.get("/callback", response_class=HTMLResponse)
async def callback(code: str = None, state: str = None, error: str = None):
    return await spotify.callback(code, state, error)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=spotify.PORT, log_config=None, access_log=False)
