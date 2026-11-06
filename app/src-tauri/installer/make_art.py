"""Renders the Wavelog icon set and the installer images.

Run from the repo root:  backend\\.venv\\Scripts\\python app\\src-tauri\\installer\\make_art.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent / "icons"
FONTS = HERE.parents[2] / "backend" / "fonts"
TOP, BOTTOM = (90, 226, 138), (34, 192, 195)  # accent gradient, same as the sidebar logo


def gradient(size, a=TOP, b=BOTTOM):
    w, h = size
    g = Image.new("RGB", (w, h))
    px = g.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g


def logo(n):
    """Rounded gradient tile with three white bars, n x n, RGBA."""
    s = 4 * n  # draw big, then scale down for smooth edges
    tile = gradient((s, s)).convert("RGBA")
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=round(s * 0.225), fill=255)
    tile.putalpha(mask)
    shine = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shine).rounded_rectangle((0, -s // 4, s - 1, s * 0.42), radius=round(s * 0.225), fill=(255, 255, 255, 40))
    shine = shine.filter(ImageFilter.GaussianBlur(s * 0.06))
    tile = Image.alpha_composite(tile, Image.composite(shine, Image.new("RGBA", (s, s), (0, 0, 0, 0)), mask))
    d = ImageDraw.Draw(tile)
    bw, r = s * 0.117, s * 0.04
    for x, top in ((0.246, 0.508), (0.441, 0.293), (0.637, 0.41)):
        d.rounded_rectangle((s * x, s * top, s * x + bw, s * 0.754), radius=r, fill=(255, 255, 255, 255))
    return tile.resize((n, n), Image.LANCZOS)


def font(weight, size):
    return ImageFont.truetype(str(FONTS / f"inter-latin-{weight}-normal.woff"), size)


# App icons
ICONS.mkdir(exist_ok=True)
big = logo(1024)
big.save(HERE.parents[1] / "app-icon.png")
for name, n in (("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)):
    logo(n).save(ICONS / name)
logo(256).save(ICONS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# Installer sidebar (welcome and finish pages): dark glass with an accent glow
W, H = 164, 314
side = Image.new("RGB", (W, H), (8, 10, 12))
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((-70, -40, 150, 170), fill=(40, 150, 95))
gd.ellipse((40, 170, 260, 380), fill=(20, 110, 120))
glow = glow.filter(ImageFilter.GaussianBlur(42))
side = Image.blend(side, glow, 0.55)
mark = logo(64)
side.paste(mark, ((W - 64) // 2, 74), mark)
d = ImageDraw.Draw(side)
f = font(600, 22)
tw = d.textlength("Wavelog", font=f)
d.text(((W - tw) / 2, 150), "Wavelog", font=f, fill=(255, 255, 255))
small = font(400, 11)
for i, line in enumerate(("Your listening,", "kept on your PC")):
    lw = d.textlength(line, font=small)
    d.text(((W - lw) / 2, 184 + i * 15), line, font=small, fill=(180, 190, 186))
side.save(HERE / "sidebar.bmp")

# Installer header (inner pages, top right on white)
W, H = 150, 57
head = Image.new("RGB", (W, H), (255, 255, 255))
mark = logo(34)
d = ImageDraw.Draw(head)
f = font(600, 17)
tw = d.textlength("Wavelog", font=f)
x = W - 10 - tw
head.paste(mark, (round(x - 42), (H - 34) // 2), mark)
d.text((x, (H - 21) / 2), "Wavelog", font=f, fill=(20, 20, 22))
head.save(HERE / "header.bmp")
print("icons and installer images written")
