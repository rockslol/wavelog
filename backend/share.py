import asyncio
import io
import os
import sys
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

import api
from pcwatch import DOWNLOADS
from widgets import http

router = APIRouter()
FONTS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "fonts"
SYSTEM = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
# The bundled Inter only has Latin letters (no ő or ű, no Cyrillic, Greek, Chinese, Japanese, Korean). Anything it
# lacks is drawn with Windows' own fonts, in this order.
FALLBACK = {False: ["segoeui.ttf", "msyh.ttc", "YuGothM.ttc", "malgun.ttf", "Nirmala.ttf", "seguisym.ttf"],
            True: ["seguisb.ttf", "msyhbd.ttc", "YuGothB.ttc", "malgunbd.ttf", "NirmalaB.ttf", "seguisym.ttf"]}
W, H = 1080, 1350


@lru_cache
def fonts(size, bold=False):
    chain = [ImageFont.truetype(str(FONTS / f"inter-latin-{600 if bold else 400}-normal.woff"), size)]
    return chain + [ImageFont.truetype(str(SYSTEM / f), size) for f in FALLBACK[bold] if (SYSTEM / f).exists()]


@lru_cache(maxsize=None)
def blank(f):
    """What the font draws for a letter it doesn't have (its "missing" box), to tell real letters from it."""
    m = f.getmask("\U0010fffd")
    return m.size, bytes(m)


@lru_cache(maxsize=100_000)
def has(f, ch):
    if ch.isspace():
        return True
    m = f.getmask(ch)
    return (m.size, bytes(m)) != blank(f)


def runs(text, chain):
    """The text split into pieces, each with a font that has its letters. One font for all of it when one can."""
    whole = next((f for f in chain if all(has(f, c) for c in text)), None)
    if whole:
        return [(text, whole)]
    out = []
    for c in text:
        f = next((f for f in chain if has(f, c)), chain[0])
        if out and out[-1][1] is f:
            out[-1] = (out[-1][0] + c, f)
        else:
            out.append((c, f))
    return out


def width(text, chain):
    return sum(f.getlength(t) for t, f in runs(text, chain))


def write(d, xy, text, size, bold=False, fill="white", fit=None):
    chain = fonts(size, bold)
    if fit and width(text, chain) > fit:
        while text and width(text + "...", chain) > fit:
            text = text[:-1]
        text = text.rstrip() + "..."
    x, y = xy
    base = y + chain[0].getmetrics()[0]  # one baseline for every font, so mixed scripts sit on the same line
    for t, f in runs(text, chain):
        d.text((x, base), t, font=f, fill=fill, anchor="ls")
        x += f.getlength(t)


def rounded(im, size, radius):
    im = ImageOps.fit(im.convert("RGB"), (size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius, fill=255)
    im.putalpha(mask)
    return im


def render(year, s, artist, tracks, images):
    base = images.get(artist and artist["image"]) or next(iter(images.values()), None)
    bg = ImageOps.fit(base.convert("RGB"), (W, H)) if base else Image.new("RGB", (W, H), (20, 20, 24))
    bg = ImageEnhance.Color(ImageEnhance.Brightness(bg.filter(ImageFilter.GaussianBlur(70))).enhance(0.42)).enhance(1.5)
    card = bg.convert("RGBA")
    glass = Image.new("RGBA", (W, H), 0)
    g = ImageDraw.Draw(glass)
    g.rounded_rectangle((48, 700, W - 48, H - 110), 44, fill=(255, 255, 255, 22), outline=(255, 255, 255, 46), width=2)
    card = Image.alpha_composite(card, glass)
    d = ImageDraw.Draw(card)
    grey = (255, 255, 255, 170)
    write(d, (80, 90), f"My {year} in music", 44, True)
    write(d, (72, 150), f"{s['minutes']:,}", 170, True)
    write(d, (80, 350), "minutes listened", 40, fill=grey)
    if artist:
        if artist["image"] in images:
            photo = rounded(images[artist["image"]], 200, 100)
            card.alpha_composite(photo, (80, 450))
        write(d, (310, 490), "Top artist", 32, fill=grey)
        write(d, (310, 535), artist["name"], 64, True, fit=W - 390)
    write(d, (96, 740), "Top songs", 34, True)
    for i, t in enumerate(tracks):
        y = 805 + i * 82
        if t["image"] in images:
            card.alpha_composite(rounded(images[t["image"]], 64, 12), (96, y))
        write(d, (184, y + 4), f"{i + 1}. {t['name']}", 32, True, fit=W - 300)
        write(d, (184, y + 40), t["artists"] or "", 24, fill=grey, fit=W - 300)
    write(d, (80, H - 80), f"{s['plays']:,} plays · {s['tracks']:,} songs · {s['artists']:,} artists", 28, fill=grey)
    out = DOWNLOADS / f"Wavelog Wrapped {year}.png"
    out.parent.mkdir(exist_ok=True)
    card.convert("RGB").save(out)
    return str(out)


async def fetch(url):
    try:
        r = await http.get(url)
        return url, Image.open(io.BytesIO(r.content))
    except Exception:
        return url, None


@router.post("/share/wrapped")
async def wrapped(year: int):
    s = await api.summary("all", year)
    artist = (await api.top("artists", "all", year, 1) or [None])[0]
    tracks = await api.top("tracks", "all", year, 5)
    urls = {x["image"] for x in [artist, *tracks] if x and x.get("image")}
    images = {u: im for u, im in await asyncio.gather(*map(fetch, urls)) if im}
    return {"path": await asyncio.to_thread(render, year, s, artist, tracks, images)}
