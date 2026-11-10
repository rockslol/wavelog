"""What a Wavelog plugin imports: `from wavelog import Plugin, ui`.

A plugin is a folder with plugin.json and main.py. main.py makes one Plugin and registers its parts with decorators:

    p = Plugin()

    @p.job(every=900)                  # runs in the background, shown in Settings > Advanced > Background jobs
    async def sync(ctx): ...

    @p.page("Valorant", ranges=True)   # a tab in the stats window; gets range="today"|"week"|"month"|"year"|"all"
    async def page(ctx, range): return [ui.header(...), ui.tiles(...)]

    @p.action                          # called by buttons, cards and search boxes
    async def refresh(ctx): ...

Handlers can be async or plain functions (plain ones run on a worker thread, so slow code doesn't freeze Wavelog).
Each one gets `ctx` first and only the other arguments it names. The page, widget and notch handlers return a list
of blocks made with `ui`, which Wavelog draws in its own style.
"""

API = 1

# What plugins can import. Wavelog runs as one bundled exe, so only these are in it (plus what the plugin ships in a
# lib/ folder, pure Python only). The build reads this list, so it is the list.
MODULES = (
    # standard library
    "asyncio", "base64", "binascii", "bisect", "calendar", "collections", "concurrent.futures", "configparser", "contextlib",
    "copy", "csv", "ctypes", "ctypes.wintypes", "dataclasses", "datetime", "decimal", "difflib", "email", "enum", "fnmatch",
    "fractions", "functools", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "html.parser", "http.cookies", "io",
    "itertools", "json", "locale", "logging", "math", "operator", "os", "pathlib", "platform", "pprint", "queue", "random",
    "re", "secrets", "shutil", "socket", "sqlite3", "ssl", "statistics", "string", "struct", "subprocess", "tempfile",
    "textwrap", "threading", "time", "tomllib", "typing", "unicodedata", "urllib.parse", "urllib.request", "uuid",
    "winreg", "xml.dom.minidom", "xml.etree.ElementTree", "zipfile", "zoneinfo",
    # bundled packages
    "httpx", "PIL", "psutil",
)


class Plugin:
    def __init__(self):
        self.jobs = []        # (fn, every, wait)
        self.pages = {}       # id -> (fn, title, ranges)
        self.widgets = {}     # id -> (fn, title, sizes)
        self.sections = {}    # id -> (fn, title)
        self.actions = {}     # name -> fn
        self.overlays = []    # (fn, game exe, key)
        self.ducks = []       # fn(ctx) -> bool, "lower Spotify now?"
        self.hooks = {}       # "start" / "stop" / "settings" -> fn

    def job(self, every, wait=0):
        """A background job. `every` is seconds, or a function of ctx that returns seconds. `wait` delays the first run."""
        def add(fn):
            self.jobs.append((fn, every, wait))
            return fn
        return add

    def page(self, title, ranges=False):
        def add(fn):
            self.pages[fn.__name__] = (fn, title, ranges)
            return fn
        return add

    def widget(self, title, sizes="sml"):
        def add(fn):
            self.widgets[fn.__name__] = (fn, title, sizes)
            return fn
        return add

    def notch_section(self, title):
        def add(fn):
            self.sections[fn.__name__] = (fn, title)
            return fn
        return add

    def overlay(self, game, key="Tab"):
        """A panel shown while `key` is held in `game` (its exe name)."""
        def add(fn):
            self.overlays.append((fn, game, key))
            return fn
        return add

    def action(self, fn):
        self.actions[fn.__name__] = fn
        return fn

    def duck(self, fn):
        self.ducks.append(fn)
        return fn

    def on_start(self, fn):
        self.hooks["start"] = fn
        return fn

    def on_stop(self, fn):
        self.hooks["stop"] = fn
        return fn

    def on_settings(self, fn):
        """Called after the user changes one of the plugin's settings."""
        self.hooks["settings"] = fn
        return fn


def _b(kind, **kw):
    return {"type": kind, **{k: v for k, v in kw.items() if v is not None}}


def _act(action, args):
    return {"action": action, "args": args} if action else {}


class ui:
    """Blocks. Images can be https links (Wavelog fetches and caches them) or files in the plugin folder."""

    # --- Top of a page -------------------------------------------------------------------------------------------
    @staticmethod
    def header(title, sub=None, image=None, note=None, bar=None, round=False):
        """Big card with a picture: e.g. your rank. `bar` is 0 to 1 for a progress bar, `note` a small line under it."""
        return _b("header", title=title, sub=sub, image=image, note=note, bar=bar, round=round or None)

    @staticmethod
    def hero(title, text=None, label=None, button=None, action=None, args=None):
        """An intro card with one button, e.g. "Turn on" before the plugin is set up."""
        return _b("hero", title=title, text=text, label=label, button=button, **_act(action, args))

    # --- Numbers -------------------------------------------------------------------------------------------------
    @staticmethod
    def tiles(*tiles):
        return _b("tiles", items=list(tiles[0]) if len(tiles) == 1 and isinstance(tiles[0], (list, tuple)) else list(tiles))

    @staticmethod
    def tile(label, value, sub=None):
        return {"label": label, "value": value, "sub": sub}

    @staticmethod
    def bars(title, data, unit="", hint=None):
        """A column chart. `data` is a list of (label, value)."""
        return _b("bars", title=title, hint=hint, unit=unit, data=[{"label": str(l), "value": v} for l, v in data])

    # --- Lists and grids -----------------------------------------------------------------------------------------
    @staticmethod
    def list(title, items, hint=None, ranked=False, empty=None):
        return _b("list", title=title, hint=hint, items=items, ranked=ranked or None, empty=empty)

    @staticmethod
    def item(title, sub=None, image=None, right=None, mood=None, meter=None, round=False, chips=None, action=None, args=None):
        """A list row. `right` is a short value on the right, `mood` "up"/"down" colours it, `meter` is 0 to 1,
        `chips` a row of small coloured marks under the text (see ui.chip)."""
        return {k: v for k, v in dict(title=title, sub=sub, image=image, right=right, mood=mood, meter=meter, round=round or None,
                                      chips=chips, **_act(action, args)).items() if v is not None}

    @staticmethod
    def grid(title, items, hint=None, columns=4, empty=None):
        return _b("grid", title=title, hint=hint, items=items, columns=columns, empty=empty)

    @staticmethod
    def card(title, sub=None, image=None, color=None, badge=None, on=None, action=None, args=None):
        """A grid card. `color` tints it, `badge` is a small tag in the corner. With `on` (True/False) and an action
        it gets a heart you can click, e.g. to add a skin to a wishlist."""
        return {k: v for k, v in dict(title=title, sub=sub, image=image, color=color, badge=badge, on=on, **_act(action, args)).items()
                if v is not None}

    # --- Small things --------------------------------------------------------------------------------------------
    @staticmethod
    def chips(items, title=None):
        return _b("chips", title=title, items=items)

    @staticmethod
    def chip(text, color=None, action=None, args=None):
        return {k: v for k, v in dict(text=text, color=color, **_act(action, args)).items() if v is not None}

    @staticmethod
    def text(text, muted=True):
        return _b("text", text=text, muted=muted)

    @staticmethod
    def buttons(*buttons):
        return _b("buttons", items=list(buttons))

    @staticmethod
    def button(label, action, args=None, primary=False):
        return {"label": label, "primary": primary, **_act(action, args)}

    @staticmethod
    def search(title, action, placeholder="Search", hint=None):
        """A search box. Typing calls `action` with q="what was typed"; it returns ui.item rows to pick from."""
        return _b("search", title=title, hint=hint, placeholder=placeholder, action=action)

    @staticmethod
    def columns(*blocks):
        """Two (or three) blocks side by side."""
        return _b("columns", items=list(blocks))
