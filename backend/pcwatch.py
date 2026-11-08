"""What the notch shows about this PC: apps using the mic or camera, browser downloads, new screenshots, and
controller / headset batteries.

Nothing runs in the background. The notch asks /pc/live about every 1.5 s while it's on screen, and each call reads
the current state: a few registry keys, two folder listings, and (every 30 s) the battery levels.
"""
import asyncio
import ctypes
import io
import itertools
import os
import re
import time
import uuid
import winreg
from ctypes import wintypes as W
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

router = APIRouter()


def known_folder(guid):
    p = ctypes.c_wchar_p()
    if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.c_char_p(uuid.UUID(guid).bytes_le), 0, None, ctypes.byref(p)) != 0:
        return None
    try:
        return Path(p.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(p)


DOWNLOADS = known_folder("374DE290-123F-4565-9164-39C4925E467B") or Path.home() / "Downloads"
SHOT_DIRS = list(dict.fromkeys(d for d in (
    known_folder("b7bede81-df94-4682-a7d8-57a52620b86f"),  # Pictures\Screenshots (Snipping Tool, Win+PrtSc)
    Path(os.environ["OneDrive"]) / "Pictures" / "Screenshots" if os.environ.get("OneDrive") else None,
) if d))


# --- Mic and camera ---------------------------------------------------------------------------------------------
# Windows keeps a key per app that used the mic/camera. LastUsedTimeStop is 0 while the app is using it right now.
CONSENT = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"
NAMES = {"discord": "Discord", "chrome": "Chrome", "msedge": "Edge", "brave": "Brave", "firefox": "Firefox", "opera": "Opera",
         "zoom": "Zoom", "ms-teams": "Teams", "teams": "Teams", "obs64": "OBS", "steam": "Steam", "steamwebhelper": "Steam",
         "valorant-win64-shipping": "Valorant", "riotclientservices": "Riot Client", "whatsapp": "WhatsApp", "slack": "Slack", "medalencoder": "Medal"}


def app_name(key):
    if "#" in key:  # NonPackaged: the exe path with # for \
        base = key.rsplit("#", 1)[-1].rsplit(".", 1)[0]
    else:  # Store app: Publisher.AppName_hash
        base = key.split("_")[0].rsplit(".", 1)[-1]
    return NAMES.get(base.lower()) or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base[:1].upper() + base[1:])


def in_use(capability):
    found = set()

    def walk(path):
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, path)
        except OSError:
            return
        with key:
            for i in itertools.count():
                try:
                    sub = winreg.EnumKey(key, i)
                except OSError:
                    break
                if sub == "NonPackaged":
                    walk(path + "\\" + sub)
                    continue
                try:
                    with winreg.OpenKey(key, sub) as k:
                        if winreg.QueryValueEx(k, "LastUsedTimeStop")[0] == 0 and winreg.QueryValueEx(k, "LastUsedTimeStart")[0]:
                            found.add(app_name(sub))
                except OSError:
                    pass

    walk(CONSENT + "\\" + capability)
    return sorted(found)


# --- Downloads ----------------------------------------------------------------------------------------------------
# Browsers write to a temporary name (.crdownload Chrome/Edge/Brave, .part Firefox, .opdownload Opera) and rename it
# when done. The total size isn't known from the file, so active downloads show size and speed, not a percentage.
TEMP = (".crdownload", ".part", ".opdownload", ".partial")
SKIP = (".tmp", ".ini", ".lnk")
dl = {"prev": None, "temps": set(), "at": 0.0, "size": {}, "speed": {}, "done": []}


def downloads():
    now = time.time()
    try:
        entries = {}
        for e in os.scandir(DOWNLOADS):
            if e.is_file():
                st = e.stat()
                entries[e.name] = (st.st_size, st.st_mtime)
    except OSError:
        return {"active": [], "done": dl["done"]}
    temps = {n for n in entries if n.lower().endswith(TEMP)}
    dt = now - dl["at"]
    active = []
    for n in temps:
        size, old = entries[n][0], dl["size"].get(n)
        if old is not None and 0 < dt < 30:
            sp = max(0.0, (size - old) / dt)
            dl["speed"][n] = sp if n not in dl["speed"] else dl["speed"][n] * 0.5 + sp * 0.5
        dl["size"][n] = size
        name = n.rsplit(".", 1)[0]
        active.append({"name": "" if name.lower().startswith("unconfirmed ") else name, "size": size,
                       "speed": round(dl["speed"].get(n, 0))})
    for n in set(dl["size"]) - temps:
        dl["size"].pop(n, None)
        dl["speed"].pop(n, None)

    prev = dl["prev"]
    if prev is not None and dt < 30:
        finished = bool(dl["temps"] - temps)  # a temp file went away: its final file was just written
        for n, (size, mtime) in entries.items():
            if n in temps or size == 0 or now - mtime > 20 or n.lower().endswith(SKIP) or n.startswith("~$"):
                continue
            if n not in prev or (finished and prev[n] != (size, mtime)):
                if not any(d["name"] == n and now - d["at"] < 60 for d in dl["done"]):
                    dl["done"].insert(0, {"name": n, "path": str(DOWNLOADS / n), "size": size, "at": now})
    dl["done"] = [d for d in dl["done"] if now - d["at"] < 3600][:5]
    dl.update(prev=entries, temps=temps, at=now)
    return {"active": sorted(active, key=lambda a: -a["size"]), "done": dl["done"]}


# --- Screenshots --------------------------------------------------------------------------------------------------
IMAGES = (".png", ".jpg", ".jpeg")
shots = {"base": None, "last": None, "thumb": None}


def newest_shot():
    best = None
    for d in SHOT_DIRS:
        try:
            for e in os.scandir(d):
                if e.is_file() and e.name.lower().endswith(IMAGES):
                    m = e.stat().st_mtime
                    if best is None or m > best[0]:
                        best = (m, e.path)
        except OSError:
            pass
    return best


def screenshot():
    b = newest_shot()
    if shots["base"] is None:  # first look: only shots taken from now on count
        shots["base"] = b[0] if b else 0
        return None
    if b and b[0] > shots["base"]:
        shots["base"] = b[0]
        shots["last"] = {"id": int(b[0] * 1000), "path": b[1], "name": os.path.basename(b[1]), "at": b[0]}
    s = shots["last"]
    return s if s and time.time() - s["at"] < 120 and os.path.exists(s["path"]) else None


def last_shot(id):
    s = shots["last"]
    if not s or s["id"] != id or not os.path.exists(s["path"]):
        raise HTTPException(404)
    return s


@router.get("/pc/shot/{id}.jpg")
async def shot_thumb(id: int):
    s = last_shot(id)
    if not shots["thumb"] or shots["thumb"][0] != id:
        from PIL import Image
        with Image.open(s["path"]) as im:
            im.thumbnail((480, 300))
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=82)
        shots["thumb"] = (id, buf.getvalue())
    return Response(shots["thumb"][1], media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@router.post("/pc/shot/{id}/open")
async def shot_open(id: int):
    os.startfile(last_shot(id)["path"])
    return {"ok": True}


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [("hwnd", W.HWND), ("wFunc", W.UINT), ("pFrom", W.LPCWSTR), ("pTo", W.LPCWSTR), ("fFlags", ctypes.c_ushort),
                ("fAnyOperationsAborted", W.BOOL), ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", W.LPCWSTR)]


@router.post("/pc/shot/{id}/delete")
async def shot_delete(id: int):
    """Moves the screenshot to the Recycle Bin (so it can be restored)."""
    s = last_shot(id)
    op = SHFILEOPSTRUCTW(None, 3, s["path"] + "\0", None, 0x40 | 0x10 | 0x4 | 0x400)  # DELETE, ALLOWUNDO|NOCONFIRMATION|SILENT|NOERRORUI
    ok = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0
    if ok:
        shots["last"] = None
    return {"ok": ok}


# --- Batteries ----------------------------------------------------------------------------------------------------
class XBAT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ubyte), ("level", ctypes.c_ubyte)]


class GUID(ctypes.Structure):
    _fields_ = [("a", ctypes.c_ulong), ("b", ctypes.c_ushort), ("c", ctypes.c_ushort), ("d", ctypes.c_ubyte * 8)]


def guid(s):
    g = GUID()
    ctypes.memmove(ctypes.byref(g), uuid.UUID(s).bytes_le, 16)
    return g


class DEVPROPKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", ctypes.c_ulong)]


class SP_DEVINFO_DATA(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("ClassGuid", GUID), ("DevInst", W.DWORD), ("Reserved", ctypes.c_void_p)]


class SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = [("cbSize", W.DWORD), ("InterfaceClassGuid", GUID), ("Flags", W.DWORD), ("Reserved", ctypes.c_void_p)]


class OVERLAPPED(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p), ("Offset", W.DWORD), ("OffsetHigh", W.DWORD),
                ("hEvent", W.HANDLE)]


sa, k32, hid = ctypes.windll.setupapi, ctypes.windll.kernel32, ctypes.windll.hid
sa.SetupDiGetClassDevsW.restype = ctypes.c_void_p
sa.SetupDiGetClassDevsW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_void_p, W.DWORD]
sa.SetupDiEnumDeviceInfo.argtypes = [ctypes.c_void_p, W.DWORD, ctypes.POINTER(SP_DEVINFO_DATA)]
sa.SetupDiGetDevicePropertyW.argtypes = [ctypes.c_void_p, ctypes.POINTER(SP_DEVINFO_DATA), ctypes.POINTER(DEVPROPKEY),
                                         ctypes.POINTER(W.ULONG), ctypes.c_void_p, W.DWORD, ctypes.POINTER(W.DWORD), W.DWORD]
sa.SetupDiEnumDeviceInterfaces.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(GUID), W.DWORD,
                                           ctypes.POINTER(SP_DEVICE_INTERFACE_DATA)]
sa.SetupDiGetDeviceInterfaceDetailW.argtypes = [ctypes.c_void_p, ctypes.POINTER(SP_DEVICE_INTERFACE_DATA), ctypes.c_void_p, W.DWORD,
                                                ctypes.POINTER(W.DWORD), ctypes.c_void_p]
sa.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]
k32.CreateFileW.restype = W.HANDLE
k32.CreateFileW.argtypes = [W.LPCWSTR, W.DWORD, W.DWORD, ctypes.c_void_p, W.DWORD, W.DWORD, W.HANDLE]
k32.CreateEventW.restype = W.HANDLE
k32.ReadFile.argtypes = [W.HANDLE, ctypes.c_void_p, W.DWORD, ctypes.c_void_p, ctypes.POINTER(OVERLAPPED)]
k32.GetOverlappedResult.argtypes = [W.HANDLE, ctypes.POINTER(OVERLAPPED), ctypes.POINTER(W.DWORD), W.BOOL]
k32.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
k32.CancelIo.argtypes = [W.HANDLE]
k32.CloseHandle.argtypes = [W.HANDLE]
hid.HidD_GetFeature.argtypes = [W.HANDLE, ctypes.c_void_p, W.ULONG]

BT_BATTERY = DEVPROPKEY(guid("104EA319-6EE2-4701-BD47-8DDBF425BBE5"), 2)
FRIENDLY = DEVPROPKEY(guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14)
DESC = DEVPROPKEY(guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 2)
INVALID = W.HANDLE(-1).value
# Sony controllers: DualShock 4 (two models), DualSense, DualSense Edge
SONY = {"05c4": "DualShock 4", "09cc": "DualShock 4", "0ce6": "DualSense", "0df2": "DualSense Edge"}


def kind(name):
    n = name.lower()
    if any(w in n for w in ("controller", "gamepad", "dualsense", "dualshock", "xbox")):
        return "controller"
    if any(w in n for w in ("head", "buds", "airpods", "earphone", "wh-", "wf-", "arctis", "hyperx", "audio", "speaker")):
        return "headset"
    return "device"


def xbox():
    """XInput only says Empty/Low/Medium/Full."""
    out, x = [], ctypes.windll.xinput1_4
    for user in range(4):
        for devtype, label in ((0, "Xbox controller"), (1, "Xbox headset")):
            b = XBAT()
            if x.XInputGetBatteryInformation(user, devtype, ctypes.byref(b)) == 0 and b.type not in (0,):
                if b.type == 1:
                    out.append({"name": label, "kind": "controller" if devtype == 0 else "headset", "level": None, "text": "Wired"})
                else:
                    out.append({"name": label, "kind": "controller" if devtype == 0 else "headset", "level": [5, 20, 60, 100][min(b.level, 3)],
                                "text": ["Empty", "Low", "Medium", "Full"][min(b.level, 3)]})
    return out


def bluetooth():
    """Devices that report a battery level to Windows (the % shown in Settings > Bluetooth)."""
    out = []
    h = sa.SetupDiGetClassDevsW(None, None, None, 0x2 | 0x4)  # PRESENT | ALLCLASSES
    try:
        buf, t, need = ctypes.create_string_buffer(512), W.ULONG(), W.DWORD()
        for i in itertools.count():
            d = SP_DEVINFO_DATA(cbSize=ctypes.sizeof(SP_DEVINFO_DATA))
            if not sa.SetupDiEnumDeviceInfo(h, i, ctypes.byref(d)):
                break
            if not sa.SetupDiGetDevicePropertyW(h, ctypes.byref(d), ctypes.byref(BT_BATTERY), ctypes.byref(t), buf, 512, ctypes.byref(need), 0):
                continue
            level = buf.raw[0]
            name = "Bluetooth device"
            for key in (FRIENDLY, DESC):
                if sa.SetupDiGetDevicePropertyW(h, ctypes.byref(d), ctypes.byref(key), ctypes.byref(t), buf, 512, ctypes.byref(need), 0):
                    name = buf.raw[:need.value].decode("utf-16-le", "ignore").rstrip("\0") or name
                    break
            out.append({"name": name, "kind": kind(name), "level": min(level, 100), "text": f"{min(level, 100)}%"})
    finally:
        sa.SetupDiDestroyDeviceInfoList(h)
    return out


def hid_paths():
    g = GUID()
    hid.HidD_GetHidGuid(ctypes.byref(g))
    h = sa.SetupDiGetClassDevsW(ctypes.byref(g), None, None, 0x2 | 0x10)  # PRESENT | DEVICEINTERFACE
    try:
        for i in itertools.count():
            d = SP_DEVICE_INTERFACE_DATA(cbSize=ctypes.sizeof(SP_DEVICE_INTERFACE_DATA))
            if not sa.SetupDiEnumDeviceInterfaces(h, None, ctypes.byref(g), i, ctypes.byref(d)):
                break
            need = W.DWORD()
            sa.SetupDiGetDeviceInterfaceDetailW(h, ctypes.byref(d), None, 0, ctypes.byref(need), None)
            buf = ctypes.create_string_buffer(need.value)
            ctypes.c_ulong.from_buffer(buf).value = 8  # cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W on 64-bit
            if sa.SetupDiGetDeviceInterfaceDetailW(h, ctypes.byref(d), buf, need, None, None):
                yield ctypes.wstring_at(ctypes.addressof(buf) + 4)
    finally:
        sa.SetupDiDestroyDeviceInfoList(h)


def read_report(h, size=128, ms=250):
    buf, n = ctypes.create_string_buffer(size), W.DWORD()
    ev = k32.CreateEventW(None, True, False, None)
    ov = OVERLAPPED(hEvent=ev)
    try:
        k32.ReadFile(h, buf, size, None, ctypes.byref(ov))
        if k32.WaitForSingleObject(ev, ms) != 0:
            k32.CancelIo(h)
            return b""
        k32.GetOverlappedResult(h, ctypes.byref(ov), ctypes.byref(n), False)
        return buf.raw[:n.value]
    finally:
        k32.CloseHandle(ev)


def sony():
    """Reads one input report from each PlayStation controller. Byte layout from the Linux hid-playstation driver."""
    out, seen = [], set()
    for path in hid_paths():
        p = path.lower()
        m = re.search(r"vid_054c&pid_([0-9a-f]{4})", p)
        if not m or m.group(1) not in SONY or p.split("#")[1] in seen:
            continue
        h = k32.CreateFileW(path, 0x80000000 | 0x40000000, 0x1 | 0x2, None, 3, 0x40000000, None)  # read/write, share, OPEN_EXISTING, OVERLAPPED
        if not h or h == INVALID:
            continue
        try:
            r = read_report(h)
            if r[:1] == b"\x01" and len(r) < 30:  # Bluetooth before the full report is switched on: reading feature 0x05/0x02 does that
                f = ctypes.create_string_buffer(b"\x05" if SONY[m.group(1)].startswith("DualSense") else b"\x02", 64)
                hid.HidD_GetFeature(h, f, 64)
                r = read_report(h)
        finally:
            k32.CloseHandle(h)
        if not r:
            continue
        name, level, charging = SONY[m.group(1)], None, False
        if name.startswith("DualSense"):
            at = {0x01: 53, 0x31: 54}.get(r[0])
            if at and len(r) > at:
                s = r[at]
                level, charging = (100 if s >> 4 == 2 else min((s & 0x0F) * 10 + 5, 100)), s >> 4 == 1
        else:
            at = {0x01: 30, 0x11: 32}.get(r[0])
            if at and len(r) > at:
                s, cable = r[at] & 0x0F, bool(r[at] & 0x10)
                level, charging = min(round(s / (11 if cable else 10) * 100), 100), cable and s < 11
        if level is None:
            continue
        seen.add(p.split("#")[1])
        out.append({"name": name, "kind": "controller", "level": level, "text": f"{level}%" + (" · charging" if charging else "")})
    return out


# Logitech mice, keyboards and headsets on a LIGHTSPEED/Unifying receiver (or Bluetooth): HID++ 2.0 over Logitech's
# vendor channel, the same way G HUB and Solaar ask. Only "get" requests are sent.
k32.WriteFile.argtypes = [W.HANDLE, ctypes.c_void_p, W.DWORD, ctypes.c_void_p, ctypes.POINTER(OVERLAPPED)]
VOLTS = ((4186, 100), (4067, 90), (3989, 80), (3922, 70), (3859, 60), (3811, 50), (3778, 40), (3751, 30), (3717, 20),
         (3671, 10), (3646, 5), (3579, 2), (3500, 0))  # Logitech's voltage curve (from G HUB, via Solaar)
LOGI_KIND = {0: "keyboard", 2: "keyboard", 3: "mouse", 4: "mouse", 5: "mouse", 8: "headset", 10: "controller", 11: "controller", 12: "controller"}
logi_cache = {}  # (path, device index) -> (battery feature, its index, name, kind) or ("miss", time, had a device)
logi_last = {}  # (path, device index) -> (last battery entry, time)


class HIDP_CAPS(ctypes.Structure):
    _fields_ = [("Usage", ctypes.c_ushort), ("UsagePage", ctypes.c_ushort), ("InLen", ctypes.c_ushort), ("OutLen", ctypes.c_ushort),
                ("FeatLen", ctypes.c_ushort), ("Reserved", ctypes.c_ushort * 17), ("Counts", ctypes.c_ushort * 10)]


def caps(h):
    c, pp = HIDP_CAPS(), ctypes.c_void_p()
    if hid.HidD_GetPreparsedData(h, ctypes.byref(pp)):
        hid.HidP_GetCaps(pp, ctypes.byref(c))
        hid.HidD_FreePreparsedData(pp)
    return c


def write_report(h, data, ms=250):
    buf, n = ctypes.create_string_buffer(bytes(data), len(data)), W.DWORD()
    ev = k32.CreateEventW(None, True, False, None)
    ov = OVERLAPPED(hEvent=ev)
    try:
        k32.WriteFile(h, buf, len(data), None, ctypes.byref(ov))
        if k32.WaitForSingleObject(ev, ms) != 0:
            k32.CancelIo(h)
            return False
        return bool(k32.GetOverlappedResult(h, ctypes.byref(ov), ctypes.byref(n), False))
    finally:
        k32.CloseHandle(ev)


def hidpp(h, dev, feat, func, *params, ms=300):
    """One HID++ 2.0 request on the long (20-byte) channel. Returns the 16 reply bytes, or None."""
    sw = 0x0A  # our "software id", so replies to G HUB or the device's own notifications are skipped
    if not write_report(h, bytes([0x11, dev, feat, (func << 4) | sw, *params]).ljust(20, b"\0")):
        return None
    end = time.monotonic() + ms / 1000
    while (left := end - time.monotonic()) > 0:
        r = read_report(h, 64, int(left * 1000) + 1)
        if len(r) < 20 or r[1] != dev:
            continue
        if r[2] == 0xFF and r[3] == feat:  # error reply
            return None
        if r[2] == feat and r[3] == (func << 4) | sw:
            return r[4:20]
    return None


def logi_discover(h, dev):
    """Which battery feature the device has, and its name and type."""
    for fid in (0x1004, 0x1000, 0x1001):  # unified battery, battery status, battery voltage (older G mice)
        r = hidpp(h, dev, 0, 0, fid >> 8, fid & 0xFF)
        if r is None:
            return None  # nothing at this index, or it's off
        if r[0]:
            feat, fi = fid, r[0]
            break
    else:
        return None
    name, kind = "Logitech device", "device"
    r = hidpp(h, dev, 0, 0, 0x00, 0x05)  # DEVICE_NAME
    if r and r[0]:
        ni, count = r[0], hidpp(h, dev, r[0], 0)
        if count:
            chars = b""
            while len(chars) < count[0]:
                part = hidpp(h, dev, ni, 1, len(chars))
                if not part:
                    break
                chars += part[:count[0] - len(chars)]
            name = chars.split(b"\0")[0].decode("utf-8", "ignore").strip() or name
        t = hidpp(h, dev, ni, 2)
        kind = LOGI_KIND.get(t[0], kind) if t else kind
    return feat, fi, name, kind


def logi_level(h, dev, feat, fi):
    """(percent, charging) or None."""
    if feat == 0x1004:
        r = hidpp(h, dev, fi, 1)
        if not r:
            return None
        level = r[0] or {8: 100, 4: 50, 2: 20, 1: 5}.get(max((b for b in (8, 4, 2, 1) if r[1] & b), default=0))
        return level, r[2] in (1, 2)
    r = hidpp(h, dev, fi, 0)
    if not r:
        return None
    if feat == 0x1000:
        return r[0], r[2] in (1, 2, 4)
    mv = r[0] << 8 | r[1]
    for (v1, p1), (v2, p2) in zip(VOLTS, VOLTS[1:]):
        if mv >= v2:
            return (p1 if mv >= v1 else round(p2 + (p1 - p2) * (mv - v2) / (v1 - v2))), bool(r[2] & 0x80)
    return 0, bool(r[2] & 0x80)


def logitech():
    out = []
    for path in hid_paths():
        p = path.lower()
        if "vid_046d" not in p and "vid&0002046d" not in p:
            continue
        h = k32.CreateFileW(path, 0x80000000 | 0x40000000, 0x1 | 0x2, None, 3, 0x40000000, None)
        if not h or h == INVALID:
            continue
        try:
            c = caps(h)
            if c.UsagePage != 0xFF00 or c.Usage != 0x02:  # only the long HID++ channel
                continue
            product = ctypes.create_unicode_buffer(128)
            receiver = hid.HidD_GetProductString(h, product, 256) and "receiver" in product.value.lower()
            for dev in (range(1, 7) if receiver else [0xFF]):
                key = (path, dev)
                found = logi_cache.get(key)
                # A sleeping device doesn't answer. Slot 1 (where a LIGHTSPEED mouse sits) and devices seen before are
                # asked again every minute; other empty receiver slots every 15 min.
                if not found or (found[0] == "miss" and time.time() - found[1] > (60 if found[2] or dev in (1, 0xFF) else 900)):
                    found = logi_cache[key] = logi_discover(h, dev) or ("miss", time.time(), bool(found and found[2]))
                lv = None if found[0] == "miss" else logi_level(h, dev, *found[:2])
                if lv is None:
                    if found[0] != "miss":
                        logi_cache[key] = ("miss", time.time(), True)
                    last = logi_last.get(key)
                    if last and time.time() - last[1] < 1800:  # asleep: keep showing the last reading for 30 min
                        out.append(last[0])
                    continue
                entry = {"name": found[2], "kind": found[3], "level": lv[0], "text": f"{lv[0]}%" + (" · charging" if lv[1] else "")}
                logi_last[key] = (entry, time.time())
                out.append(entry)
        finally:
            k32.CloseHandle(h)
    return out


bat = {"at": 0.0, "list": []}


def batteries():
    found = []
    for source in (bluetooth, logitech, sony, xbox):
        try:
            found += source()
        except Exception:
            pass
    # An Xbox controller over Bluetooth shows up twice; keep the Bluetooth one, it has a real percentage.
    if any("xbox" in d["name"].lower() for d in found if d["text"].endswith("%")):
        found = [d for d in found if not (d["name"] == "Xbox controller" and not d["text"].endswith("%"))]
    return found


async def battery_list():
    if time.time() - bat["at"] > 30:
        bat["at"] = time.time()
        bat["list"] = await asyncio.to_thread(batteries)
    return bat["list"]


@router.get("/pc/live")
async def live(privacy: bool = True, dl: bool = True, shot: bool = True, battery: bool = True):
    return {"mic": in_use("microphone") if privacy else [], "cam": in_use("webcam") if privacy else [],
            "downloads": downloads() if dl else None, "shot": screenshot() if shot else None,
            "battery": await battery_list() if battery else []}


@router.get("/duck/state")
async def duck_state():
    """For Spotify ducking in the app: Valorant's match phase and the fullscreen game in front, if any."""
    import games
    import valorant
    g = games.game()
    return {"valorant": valorant.live_cache.get("phase") if valorant.in_valorant() else None, "game": g[0] if g else None}
