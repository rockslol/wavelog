import asyncio
import logging
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse

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
import lastfm
import pcwatch
import poller
import share
import spotify
import steam
import valorant
import widgets


@asynccontextmanager
async def lifespan(app):
    tasks = [asyncio.create_task(poller.loop(poller.poll_current, lambda: 5 if widgets.fast_poll() else 20)),
             asyncio.create_task(poller.loop(poller.poll_recent, 300)),
             asyncio.create_task(poller.loop(poller.fill_missing, 2)),
             asyncio.create_task(poller.loop(db.backup, 3600)),
             asyncio.create_task(poller.loop(games.track, games.EVERY)),
             asyncio.create_task(poller.loop(lastfm.auto, 1800)),
             asyncio.create_task(poller.loop(valorant.sync, lambda: 120 if valorant.in_valorant() else 900)),
             asyncio.create_task(poller.loop(valorant.watch, 15))]
    yield
    for t in tasks:
        t.cancel()


from version import VERSION

app = FastAPI(title="Wavelog", version=VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"],
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(api.router)
app.include_router(debug.router)
app.include_router(widgets.router)
app.include_router(share.router)
app.include_router(games.router)
app.include_router(valorant.router)
app.include_router(pcwatch.router)
app.include_router(steam.router)


@app.get("/login")
async def login():
    return RedirectResponse(spotify.auth_url())


@app.get("/callback", response_class=HTMLResponse)
async def callback(code: str = None, state: str = None, error: str = None):
    return await spotify.callback(code, state, error)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=spotify.PORT, log_config=None, access_log=False)
