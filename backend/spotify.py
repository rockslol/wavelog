import asyncio
import base64
import hashlib
import logging
import secrets
import time
import webbrowser
from urllib.parse import urlencode

import httpx

from db import DATA, read_json, write_json

CONFIG = DATA / "config.json"
cfg = read_json(CONFIG, {"client_id": ""})
PORT = 8721  # also in the app (api.js, main.rs, the CSP in tauri.conf.json): change them together
REDIRECT = f"http://127.0.0.1:{PORT}/callback"
SCOPES = "user-read-currently-playing user-read-playback-state user-read-recently-played"
TOKEN_URL = "https://accounts.spotify.com/api/token"
TOKENS = DATA / "tokens.json"


# open_browser: only right after the Client ID is entered (first setup). An expired sign-in later
# shows a warning in the app and the notch instead of popping a browser over whatever you're doing.
auth = {"open_browser": False}


def set_client_id(value):
    cfg["client_id"] = value.strip()
    write_json(CONFIG, cfg)
    auth["open_browser"] = True


def auth_state():
    if not cfg.get("client_id"):
        return "no_client_id"
    return "ok" if tokens else "signed_out"

log = logging.getLogger("spotify")
http = httpx.AsyncClient(timeout=20)
lock = asyncio.Lock()
tokens = read_json(TOKENS, None)
login = {}


def save(t):
    global tokens
    tokens = {
        "access_token": t["access_token"],
        "refresh_token": t.get("refresh_token") or tokens["refresh_token"],
        "expires_at": time.time() + t["expires_in"] - 60,
    }
    write_json(TOKENS, tokens)


def auth_url():
    if not login:
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        login.update(
            verifier=verifier,
            state=state,
            future=asyncio.get_running_loop().create_future(),
            url="https://accounts.spotify.com/authorize?" + urlencode(dict(
                client_id=cfg["client_id"], response_type="code", redirect_uri=REDIRECT, scope=SCOPES,
                code_challenge_method="S256", code_challenge=challenge, state=state,
            )),
        )
    return login["url"]


async def callback(code, state, error):
    if error or not login or state != login["state"]:
        return f"Login failed ({error or 'invalid state'}). Try again at http://127.0.0.1:{PORT}/login"
    r = await http.post(TOKEN_URL, data=dict(
        grant_type="authorization_code", code=code, redirect_uri=REDIRECT,
        client_id=cfg["client_id"], code_verifier=login["verifier"],
    ))
    if r.status_code != 200:
        log.error("Token exchange failed: %s %s", r.status_code, r.text)
        return "Token exchange failed, see the log in Wavelog: Settings > Advanced"
    save(r.json())
    login.pop("future").set_result(None)
    login.clear()
    log.info("Logged in")
    return "Logged in. You can close this tab."


async def token():
    global tokens
    async with lock:
        while not cfg.get("client_id"):
            await asyncio.sleep(5)
        while True:
            if not tokens:
                url = auth_url()
                future = login["future"]
                if auth["open_browser"]:
                    auth["open_browser"] = False
                    webbrowser.open(url)
                log.warning("Spotify sign-in needed: Settings > Advanced > Sign in, or http://127.0.0.1:%s/login", PORT)
                await future
                continue
            if time.time() < tokens["expires_at"]:
                return tokens["access_token"]
            r = await http.post(TOKEN_URL, data=dict(
                grant_type="refresh_token", refresh_token=tokens["refresh_token"], client_id=cfg["client_id"],
            ))
            if r.status_code in (400, 401):
                log.warning("Refresh token rejected (%s), re-login needed", r.text)
                tokens = None
                TOKENS.unlink(missing_ok=True)
                continue
            r.raise_for_status()
            save(r.json())


async def get(path, **params):
    delay = 5
    while True:
        try:
            r = await http.get("https://api.spotify.com/v1" + path, params=params,
                               headers={"Authorization": "Bearer " + await token()})
            if r.status_code == 401 and tokens:
                tokens["expires_at"] = 0
                await asyncio.sleep(delay)
                delay = min(delay * 2, 300)
                continue
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", delay))
                log.warning("Rate limited on %s, waiting %ss", path, wait)
                await asyncio.sleep(wait)
                continue
            if r.status_code >= 500:
                raise httpx.HTTPStatusError(f"{r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            return r.json() if r.status_code != 204 and r.content else None
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
                raise
            log.warning("%s failed (%s), retrying in %ss", path, e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 300)
