import asyncio
import io
import sys
from pathlib import Path

from fastapi import APIRouter
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

import api
from widgets import http

router = APIRouter()
FONTS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "fonts"
W, H = 1080, 1350


def font(size, bold=False):
    return ImageFont.truetype(str(FONTS / f"inter-latin-{600 if bold else 400}-normal.woff"), size)


def fit(draw, text, f, width):
    if draw.textlength(text, font=f) <= width:
        return text
    while text and draw.textlength(text + "...", font=f) > width:
        text = text[:-1]
    return text.rstrip() + "..."


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
    d.text((80, 90), f"My {year} in music", font=font(44, True), fill="white")
    d.text((72, 150), f"{s['minutes']:,}", font=font(170, True), fill="white")
    d.text((80, 350), "minutes listened", font=font(40), fill=grey)
    if artist:
        if artist["image"] in images:
            photo = rounded(images[artist["image"]], 200, 100)
            card.alpha_composite(photo, (80, 450))
        d.text((310, 490), "Top artist", font=font(32), fill=grey)
        d.text((310, 535), fit(d, artist["name"], font(64, True), W - 390), font=font(64, True), fill="white")
    d.text((96, 740), "Top songs", font=font(34, True), fill="white")
    for i, t in enumerate(tracks):
        y = 805 + i * 82
        if t["image"] in images:
            card.alpha_composite(rounded(images[t["image"]], 64, 12), (96, y))
        d.text((184, y + 4), fit(d, f"{i + 1}. {t['name']}", font(32, True), W - 300), font=font(32, True), fill="white")
        d.text((184, y + 40), fit(d, t["artists"] or "", font(24), W - 300), font=font(24), fill=grey)
    d.text((80, H - 80), f"{s['plays']:,} plays · {s['tracks']:,} songs · {s['artists']:,} artists",
           font=font(28), fill=grey)
    out = Path.home() / "Downloads" / f"Spotify Wrapped {year}.png"
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
