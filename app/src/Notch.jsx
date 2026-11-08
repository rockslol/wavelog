import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { API, get, hidden, NOTCH, NOTCH_SECTIONS, notchOptions, useLyrics, usePoll } from "./api";
import { condition, score, signed, WeatherIcon } from "./widgets";

const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60)}`;
const left = (ms) => clock(Math.ceil(ms / 1000) * 1000);
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = (s) => new Date(s.length === 10 ? s + "T00:00" : s);
const tint = (c, a = 1) => c && `rgba(${c.map((v) => Math.round(255 * (0.3 + (0.7 * v) / Math.max(...c, 0.01)))).join(",")},${a})`;
const since = (d) => d && new Date(d.replace(" ", "T")).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const APP_NAMES = { discord: "Discord", chrome: "Chrome", msedge: "Edge", brave: "Brave", firefox: "Firefox", opera: "Opera", zoom: "Zoom",
  "ms-teams": "Teams", teams: "Teams", obs64: "OBS", steam: "Steam", steamwebhelper: "Steam", "valorant-win64-shipping": "Valorant",
  riotclientservices: "Riot Client", whatsapp: "WhatsApp", slack: "Slack", medalencoder: "Medal", medal: "Medal", windowscamera: "Camera" };
const appName = (exe) => {
  const b = exe.replace(/\.exe$/i, "");
  return APP_NAMES[b.toLowerCase()] || b.charAt(0).toUpperCase() + b.slice(1);
};
const outName = (n) => {
  const m = n.match(/^(.*?)\s*\((.*)\)$/);
  return m ? [m[1], m[2]] : [n, ""];
};
const ago = (at) => {
  const m = Math.floor((Date.now() / 1000 - at) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
};
const ICONS = {
  prev: "M6 6h2v12H6zM9.5 12 18 6v12z",
  next: "M16 6h2v12h-2zM6 6l8.5 6L6 18z",
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v4.6l3.2 3.2-1.4 1.4-3.8-3.8z",
  valorant: "M2 4l11 14H8.5L2 9.6zM22 4v6l-4.6 5.5h-4.7z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  timer: "M9 2h6v2H9zM12 5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM12 7a6.5 6.5 0 1 1 0 13 6.5 6.5 0 1 1 0-13zM11 9.5h2v5h-2z",
  calendar: "M7 2h2v2h6V2h2v2h3v18H4V4h3zm-1 8v10h12V10z",
  speaker: "M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2z",
  mute: "M4 9h4l5-4v14l-5-4H4zM15.3 9.7l1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z",
  shuffle: "M10.59 9.17 5.41 4 4 5.41l5.17 5.17zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04z",
  repeat: "M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z",
  repeat1: "M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2zm-4-2V9h-1l-2 1v1h1.5v4z",
  chart: "M4 20h16v-2H4zM6 16h3V9H6zm4.5 0h3V4h-3zM15 16h3v-5h-3z",
  computer: "M3 4h18v12H3zm2 2v8h14V6zM8 18h8v2H8z",
  smartphone: "M7 2h10v20H7zm2 2v14h6V4z",
  device: "M6 2h12v20H6zm6 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  reset: "M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z",
  swap: "M7 7h11l-3-3 1.4-1.4L22 8l-5.6 5.4L15 12l3-3H7zM17 17H6l3 3-1.4 1.4L2 16l5.6-5.4L9 12l-3 3h11z",
  chip: "M9 9h6v6H9zM7 3h2v2h6V3h2v2h2v2h2v2h-2v6h2v2h-2v2h-2v2h-2v-2H9v2H7v-2H5v-2H3v-2h2V9H3V7h2V5h2zm0 4v10h10V7z",
  check: "M4 4h16v16H4zm2 2v12h12V6zm3.5 5.1L11 12.6l3.5-3.5 1.4 1.4-4.9 4.9-2.9-2.9z",
  download: "M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4 3.6 3.6zM5 18h14v2H5z",
  folder: "M3 5h7l2 2h9v12H3z",
  open: "M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z",
  trash: "M9 3h6l1 1h4v2H4V4h4zM6 8h12l-1 13H7z",
  mic: "M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 11h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h-2v-3.1A7 7 0 0 1 5 11z",
  camera: "M3 6h12v12H3zM16 10l5-3v10l-5-3z",
  battery: "M7 4h3V2h4v2h3v18H7zm2 2v14h6V6zm1 8h4v5h-4z",
  controller: "M7 6h10a5 5 0 0 1 4.9 6l-1 5a2.5 2.5 0 0 1-4.3 1.1L14.5 16h-5l-2.1 2.1A2.5 2.5 0 0 1 3.1 17l-1-5A5 5 0 0 1 7 6zm0 3v1.5H5.5v2H7V14h2v-1.5h1.5v-2H9V9zm9 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  headset: "M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z",
  mouse: "M12 2a6 6 0 0 1 6 6v8a6 6 0 0 1-12 0V8a6 6 0 0 1 6-6zm-1 2.1A4 4 0 0 0 8 8v1h3zm2 0V9h3V8a4 4 0 0 0-3-3.9zM8 11v5a4 4 0 0 0 8 0v-5z",
  keyboard: "M2 6h20v12H2zm2 2v8h16V8zm1 1h2v2H5zm3 0h2v2H8zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zM5 12h2v2H5zm3 0h8v2H8zm9 0h2v2h-2z",
  done: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.5 14.2-4.2-4.2 1.4-1.4 2.8 2.8 5.8-5.8 1.4 1.4z",
  spotify: "M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22zm5.04 15.87a.69.69 0 0 1-.94.23c-2.58-1.58-5.83-1.93-9.65-1.06a.69.69 0 1 1-.3-1.34c4.18-.95 7.77-.54 10.66 1.23.32.2.43.62.23.94zm1.35-3a.86.86 0 0 1-1.18.28c-2.95-1.81-7.45-2.34-10.94-1.28a.86.86 0 1 1-.5-1.65c3.99-1.21 8.94-.62 12.34 1.46.4.25.53.78.28 1.19zm.11-3.13C14.96 8.64 9.12 8.45 5.74 9.47a1.03 1.03 0 1 1-.6-1.97c3.88-1.18 10.33-.95 14.4 1.46a1.03 1.03 0 0 1-1.04 1.78z",
};
const Icon = ({ d }) => <svg viewBox="0 0 24 24"><path fillRule="evenodd" d={ICONS[d] || ICONS.device} /></svg>;
// Each visualizer bar wobbles at its own speed around the real audio level.
const WOBBLE = [[7.1, 0], [9.3, 1.7], [5.7, 3.1], [11.2, 4.4], [8.4, 2.3]];
const NO_TIMER = { mode: "focus", left: null, end: null, done: 0, day: "" };
const TILES = new Set(["timer", "calendar", "pc", "listening", "devices", "steam"]);
const SECTION_ICON = { clock: "clock", music: "spotify", timer: "timer", calendar: "calendar", pc: "chip", listening: "chart", devices: "battery",
  outputs: "speaker", downloads: "download", todos: "check", valorant: "valorant", steam: "controller" };

function stored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function soon(e, now) {
  const s = parse(e.start), mins = Math.ceil((s - now) / 60000);
  const days = Math.round((new Date(s).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  if (e.all_day) return days <= 0 ? "Today · all day" : days === 1 ? "Tomorrow · all day" : s.toLocaleDateString(undefined, { weekday: "long" });
  if (mins <= 0) return `Now · until ${hm(parse(e.end))}`;
  if (mins < 60) return `In ${mins} min`;
  const day = days === 0 ? "" : days === 1 ? "Tomorrow " : s.toLocaleDateString(undefined, { weekday: "short" }) + " ";
  return day + hm(s);
}

function activities(timer, ev, v, now) {
  const out = [];
  if (timer?.end > now) {
    const f = timer.mode === "focus";
    out.push({ id: "timer", icon: <Icon d="timer" />, tone: f ? "#ff9f0a" : "#30d158", label: f ? "Focus" : "Break", value: left(timer.end - now), short: left(timer.end - now) });
  }
  const e = (ev || []).find((e) => !e.all_day && Math.abs(parse(e.start) - now - 5 * 60000) < 10 * 60000);
  if (e) {
    const m = Math.ceil((parse(e.start) - now) / 60000);
    out.push({ id: "cal", icon: <Icon d="calendar" />, tone: "#ff453a", label: e.title, value: m > 0 ? `in ${m} min` : "Now", short: m > 0 ? `${m}m` : "Now" });
  }
  const m = v?.matches?.[0], end = m && m.started_at + m.length;
  if (m && now > end && now - end < 10 * 60000) {
    const res = m.won == null ? "Draw" : m.won ? "Win" : "Loss";
    const rr = m.mode === "Competitive" && m.rr != null;
    const icon = v.assets.tiers[m.tier]?.icon;
    out.push({ id: "val", icon: icon ? <img src={icon} draggable={false} /> : <Icon d="timer" />, tone: m.won == null ? "#aaa" : m.won ? "#30d158" : "#ff453a",
      label: `${res} ${score(m)} · ${m.map}`, value: rr ? `${signed(m.rr)} RR` : `${m.kills}/${m.deaths}/${m.assists}`, short: rr ? signed(m.rr) : res });
  }
  return out;
}

export default function Notch() {
  const [now, setNow] = useState(null);
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState(true);
  const [peek, setPeek] = useState(false);
  const [osd, setOsd] = useState(0);
  const [spot, setSpot] = useState(null); // Spotify's own volume (its Windows mixer level): the player slider and scrolling
  const [osdVol, setOsdVol] = useState(null); // what the volume pop-up shows: PC volume from the volume keys, or Spotify's
  const [live, setLive] = useState(false);
  const [meta, setMeta] = useState(null);
  const [up, setUp] = useState(null);
  const [todos, setTodos] = useState(null);
  const [fullH, setFullH] = useState(116);
  const [toast, setToast] = useState(null); // screenshot or finished download, dropping out of the notch for a few seconds
  const [batAlert, setBatAlert] = useState(null);
  const seen = useRef({ shot: null, dl: new Set(), bat: {} });
  const [micApps, setMicApps] = useState([]);
  const [camApps, setCamApps] = useState([]);
  const [outs, setOuts] = useState(null);
  const [edit, setEdit] = useState(null); // section order while arranging the dashboard (Settings > Notch > Edit)
  const [dragging, setDragging] = useState(null);
  const editing = useRef(false), drag = useRef(null), rects = useRef({});
  const [, tick] = useState(0);
  const timer = useRef(0), full = useRef(null), root = useRef(null), lastId = useRef(null), lastWheel = useRef(0), lastSet = useRef(0);
  const level = useRef(0), isLive = useRef(false), opts = useRef(null);

  const set = usePoll("/settings", 600000);
  const o = (opts.current = notchOptions(set));
  const on = (id) => o.sections.includes(id);
  const ev = usePoll(set?.calendars?.length ? "/calendar" : null, 300000);
  const val = usePoll(set?.valorant ? "/valorant" : null, 60000);
  const weather = usePoll("/weather", 900000);
  const pc = usePoll(open && on("pc") ? "/system" : null, 2000);
  useEffect(() => {
    invoke("notch_monitor", { name: o.monitor || "" });
  }, [o.monitor]);
  const today = usePoll(open && on("listening") ? "/today" : null, 60000);
  const streak = usePoll(open && on("listening") ? "/streaks" : null, 600000);
  const steamD = usePoll(open && on("steam") ? "/steam" : null, 60000);
  const vstore = usePoll(set?.valorant ? "/valorant/store" : null, 600000);
  const [storeAlert, setStoreAlert] = useState(null);
  const wantDl = o.downloads || on("downloads"), wantBat = o.battery || on("devices");
  const pcl = usePoll(o.privacy || o.screenshots || wantDl || wantBat
    ? `/pc/live?privacy=${+o.privacy}&shot=${+o.screenshots}&dl=${+wantDl}&battery=${+wantBat}` : null, 1500);
  useEffect(() => setTodos(null), [set]);

  const d = new Date(), ms = d.getTime();
  const has = !!now?.id;
  const playing = has && now.playing;
  const fresh = (n) => setNow({ ...n, at: Date.now() });
  const tm = stored("timer") || NO_TIMER;
  const signin = now?.auth && now.auth !== "ok" && {
    id: "auth", icon: <Icon d="spotify" />, tone: "#ff453a", label: now.auth === "no_client_id" ? "Finish Wavelog setup" : "Spotify signed out",
    value: now.auth === "no_client_id" ? "Set up" : "Sign in", short: "Sign in",
  };
  const dls = pcl?.downloads;
  // Live from Rust (mic: audio capture sessions, camera: Media Foundation's sensor monitor), plus the logger's registry
  // check, which only older Windows 11 builds still fill in.
  const mics = [...new Set([...(pcl?.mic || []), ...micApps.map(appName)])];
  const cams = [...new Set([...(pcl?.cam || []), ...camApps.map(appName)])];
  const pcActs = [];
  if (storeAlert && storeAlert.until > ms) {
    pcActs.push({ id: "vstore", icon: storeAlert.icon ? <img src={storeAlert.icon} draggable={false} /> : <Icon d="controller" />, tone: "#ff4655",
      label: `${storeAlert.name} is in your store`, value: `${storeAlert.price} VP`, short: "Store" });
  }
  if (batAlert && batAlert.until > ms) {
    pcActs.push({ id: "bat", icon: <Icon d="battery" />, tone: "#ff453a", label: `${batAlert.name} battery low`, value: batAlert.text, short: `${batAlert.level}%` });
  }
  const downloading = o.downloads && dls?.active?.length > 0 && dls.active;
  const dlAct = downloading && {
    id: "dl", icon: <Icon d="download" />, tone: "#0a84ff", label: downloading.length > 1 ? `${downloading.length} downloads` : downloading[0].name || "Downloading",
    value: bytes(downloading[0].size) + (downloading[0].speed ? ` · ${bytes(downloading[0].speed)}/s` : ""),
    short: downloading[0].speed ? `${bytes(downloading[0].speed)}/s` : bytes(downloading[0].size),
  };
  const acts = [...(signin ? [signin] : []), ...pcActs, ...activities(tm, ev, val, ms), ...(dlAct ? [dlAct] : [])];
  const pos = has ? Math.min(now.duration_ms, now.progress_ms + (now.playing ? ms - now.at : 0)) : 0;
  const ly = useLyrics(has ? now.id : null, pos, now?.duration_ms);
  const line = o.lyrics && playing && ly.synced && ly.i >= 0 ? ly.lines[ly.i][1] || "♪" : null;
  const vol = osd ? osdVol : null; // never 0: "{!has && vol}" would print it

  useEffect(() => {
    const poll = () => !hidden && get("/now").then(fresh).catch(() => setNow(null));
    poll();
    const id = setInterval(poll, 2000);
    const offs = [
      listen("hover", (e) => {
        clearTimeout(timer.current);
        if (e.payload) opts.current.open === "hover" && (timer.current = setTimeout(() => setOpen(true), 180));
        else if (!editing.current) setOpen(false);
      }),
      listen("edit", () => {
        editing.current = true;
        rects.current = {};
        setEdit(opts.current.sections.filter((id) => NOTCH_SECTIONS.some(([x]) => x === id)));
        setOpen(true);
      }),
      listen("reveal", (e) => setReveal(e.payload)),
      listen("sysvol", (e) => opts.current.osd && (setOsdVol({ level: e.payload[0], muted: e.payload[1] }), setOsd(Date.now()))),
      listen("level", (e) => {
        const p = e.payload;
        if (isLive.current !== p >= 0) setLive((isLive.current = p >= 0));
        if (p < 0 || !root.current) return;
        level.current = p > level.current ? p : level.current * 0.6 + p * 0.4;
        const t = performance.now() / 1000;
        WOBBLE.forEach(([f, ph], i) => {
          const b = Math.min(1, Math.max(0.18, level.current * 1.35 * (0.62 + 0.38 * Math.sin(t * f + ph))));
          root.current.style.setProperty(`--b${i}`, b.toFixed(2));
        });
      }),
    ];
    return () => (clearInterval(id), offs.forEach((o) => o.then((f) => f())));
  }, []);
  const fast = open || (playing && ly.synced);
  useEffect(() => {
    const id = setInterval(() => !hidden && tick((x) => x + 1), fast ? 250 : 1000);
    return () => clearInterval(id);
  }, [fast]);
  useEffect(() => {
    if (!now?.id) return;
    setMeta(null);
    const p = new URLSearchParams({ id: now.id, name: now.name || "", artist: now.artists || "" });
    get(`/song-plays?${p}`).then((t) => setMeta({ plays: t.plays, first: t.first })).catch(() => setMeta(null));
    if (lastId.current && now.id !== lastId.current && opts.current.peek) {
      setPeek(true);
      lastId.current = now.id;
      const id = setTimeout(() => setPeek(false), 3800);
      return () => clearTimeout(id);
    }
    lastId.current = now.id;
  }, [now?.id]);
  const loadOuts = () => invoke("audio_outputs").then(setOuts).catch(() => {});
  const realOuts = (outs || []).filter(([, n]) => !/steam streaming/i.test(n)); // Steam Remote Play's virtual devices
  useEffect(() => {
    if (open && on("outputs")) loadOuts();
  }, [open]);
  useEffect(() => {
    if (open && has) get("/upnext").then(setUp).catch(() => {});
    if (open) setVolume({}); // read Spotify's volume; its mixer row only exists once it has played sound
  }, [open, now?.id]);
  useEffect(() => {
    if (!osd) return;
    const id = setTimeout(() => setOsd(0), 1400);
    return () => clearTimeout(id);
  }, [osd]);
  // New screenshot / finished download -> toast. Battery crossing 20, 10 or 5% -> alert (once per step until it's charged).
  useEffect(() => {
    if (!pcl) return;
    const sn = seen.current, t = Date.now() / 1000;
    const shot = pcl.shot;
    if (shot && shot.id !== sn.shot) {
      sn.shot = shot.id;
      if (o.screenshots && t - shot.at < 10) setToast({ kind: "shot", ...shot, until: Date.now() + 6500 });
    }
    for (const d of pcl.downloads?.done || []) {
      const key = d.path + d.at;
      if (sn.dl.has(key)) continue;
      sn.dl.add(key);
      if (o.downloads && t - d.at < 10) setToast({ kind: "dl", ...d, until: Date.now() + 5000 });
    }
    for (const b of pcl.battery || []) {
      if (b.level == null) continue;
      const step = [5, 10, 20].find((x) => b.level <= x);
      if (b.level > 25) delete sn.bat[b.name];
      else if (step && (sn.bat[b.name] == null || step < sn.bat[b.name])) {
        sn.bat[b.name] = step;
        if (o.battery) setBatAlert({ ...b, until: Date.now() + 15000 });
      }
    }
  }, [pcl]);
  useEffect(() => {
    if (!o.privacy) return (setMicApps([]), setCamApps([]));
    const keep = (l) => (p) => (p.join() === l.join() ? p : l);
    const load = () => !hidden && Promise.all([invoke("mic_users"), invoke("camera_users")])
      .then(([m, c]) => (setMicApps(keep(m)), setCamApps(keep(c)))).catch(() => {});
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [o.privacy]);
  // A wishlisted skin in today's store or the night market: tell once per shop rotation.
  useEffect(() => {
    const hit = [...(vstore?.daily || []), ...(vstore?.night || [])].find((s) => s.wanted);
    if (!hit) return;
    const key = hit.id + ":" + Math.round(vstore.daily_ends || 0);
    if (stored("val-store-alert") === key) return;
    try {
      localStorage.setItem("val-store-alert", JSON.stringify(key));
    } catch {}
    setStoreAlert({ ...hit, until: Date.now() + 20000 });
  }, [vstore]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.until - Date.now());
    return () => clearTimeout(id);
  }, [toast]);
  useLayoutEffect(() => {
    const h = full.current?.offsetHeight;
    if (h && h !== fullH) setFullH(h);
  });

  // Focus timer: same state as the Timer widget (shared localStorage), so either one can drive it.
  const [focusMs, breakMs] = (set?.pomodoro || [25, 5]).map((m) => m * 60000);
  const tLen = tm.mode === "focus" ? focusMs : breakMs;
  const tRaw = tm.end ? tm.end - ms : tm.left ?? tLen;
  const tLeft = Math.max(0, Math.min(tRaw, tLen));
  const dayKey = d.toDateString();
  const saveTimer = (x) => {
    try {
      localStorage.setItem("timer", JSON.stringify(x));
    } catch {}
    tick((n) => n + 1);
  };
  useEffect(() => {
    // Let the Timer widget handle the switch first if it's open; take over after a grace period.
    if (tm.end && tRaw < -1500) {
      const f = tm.mode === "focus";
      saveTimer({ mode: f ? "break" : "focus", left: null, end: null, done: f ? (tm.day === dayKey ? tm.done : 0) + 1 : tm.done, day: f ? dayKey : tm.day });
    }
  });
  const toggleTimer = () => saveTimer(tm.end ? { ...tm, end: null, left: tLeft } : { ...tm, end: ms + tLeft, left: null });
  const resetTimer = () => saveTimer(tm.end || tm.left != null ? { ...tm, end: null, left: null } : { ...tm, mode: tm.mode === "focus" ? "break" : "focus" });
  const sessions = tm.day === dayKey ? tm.done : 0;

  const todoList = todos || set?.todos || [];
  const openTodos = todoList.map((t, i) => [t, i]).filter(([t]) => !t.done);
  const tickTodo = (i) => {
    const next = todoList.map((t, k) => (k === i ? { ...t, done: !t.done } : t));
    setTodos(next);
    fetch(API + "/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ todos: next }) })
      .then(() => emit("settings")).catch(() => {});
  };
  const nextEvent = (ev || []).find((e) => parse(e.end) > d);

  const alerts = o.alerts ? acts : [];
  const kind = playing ? "music" : alerts[0] ? "act" : "idle";
  const away = o.autohide && !reveal && !vol;
  const state = open || edit ? "open" : toast ? "peek" : away ? "gone" : peek && has ? "peek" : kind === "idle" && o.idle === "hide" && !vol ? "gone" : "mini";
  const bubble = (state === "mini" || state === "peek") && (kind === "music" || state === "peek" ? alerts[0] : kind === "act" ? alerts[1] : null);
  const miniW = vol || line ? 340 : kind !== "idle" ? 250 : o.idle === "time" ? 120 : 210;
  const [w, h, r] = { gone: [120, 34, 17], mini: [miniW, 34, 17], peek: toast ? [toast.kind === "shot" ? 440 : 400, 86, 30] : [380, 72, 28], open: [460, fullH, 32] }[state];
  useEffect(() => {
    invoke("notch", { w: state === "gone" ? 0 : w + 20 + (bubble ? 2 * 100 : 0), h, autohide: o.autohide && !edit });
  }, [w, h, !!bubble, state === "gone", o.autohide, !!edit]);
  const shotDo = (id, what) => fetch(`${API}/pc/shot/${id}/${what}`, { method: "POST" }).then(() => setToast(null)).catch(() => {});
  const stop = (e) => e.stopPropagation();
  const shotButtons = (sh) => (
    <div className="n-tbtns" onClick={stop}>
      <button title="Open" onClick={() => shotDo(sh.id, "open")}><Icon d="open" /></button>
      <button title="Show in folder" onClick={() => invoke("reveal", { path: sh.path })}><Icon d="folder" /></button>
      <button title="Delete (Recycle Bin)" onClick={() => shotDo(sh.id, "delete")}><Icon d="trash" /></button>
    </div>
  );
  const priv = o.privacy && (mics.length > 0 || cams.length > 0);

  const press = (key) => {
    invoke("media", { key });
    if (key === "play") setNow((n) => ({ ...n, playing: !n.playing, progress_ms: pos, at: Date.now() }));
    fetch(API + "/poke", { method: "POST" }).then((r) => r.json()).then(fresh).catch(() => {});
  };
  const setVolume = (args) => invoke("spotify_volume", args).then((r) => {
    const v = r && { level: r[0], muted: r[1], spotify: true };
    setSpot(v);
    return v;
  });
  const wheel = (e) => {
    if (!o.scroll || Date.now() - lastWheel.current < 50) return;
    lastWheel.current = Date.now();
    setVolume({ delta: e.deltaY < 0 ? 0.04 : -0.04 }).then((v) => v && !open && o.osd && (setOsdVol(v), setOsd(Date.now())));
  };
  const slide = (e) => {
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.buttons || Date.now() - lastSet.current < 30) return;
    lastSet.current = Date.now();
    const b = e.currentTarget.getBoundingClientRect();
    setVolume({ set: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) });
  };
  const openStats = () => (invoke("open_stats"), has && emitTo("stats", "open-detail", { kind: "track", id: now.id }));

  const viz = (n) => o.viz && (
    <i className={"viz" + (playing ? " on" : "") + (live ? " live" : "")}>
      {WOBBLE.slice(0, n).map((_, i) => <s key={i} style={live && playing ? { height: `calc(var(--b${i}, 0.2) * 100%)` } : null} />)}
    </i>
  );
  const cover = (cls) => (now?.image ? <img className={cls} src={now.image} draggable={false} /> : <div className={cls} />);
  const volBar = vol && (
    <div className="n-vol"><Icon d={vol.muted ? "mute" : vol.spotify ? "spotify" : "speaker"} /><div className="n-bar"><div style={{ width: (vol.muted ? 0 : vol.level * 100) + "%" }} /></div><span>{vol.muted ? "Off" : Math.round(vol.level * 100)}</span></div>
  );
  const badge = meta && (meta.plays === 0
    ? <em className="n-chip new">First listen</em>
    : <em className="n-chip">Play #{meta.plays + 1}{meta.first ? ` · since ${since(meta.first)}` : ""}</em>);
  const act = alerts[0], bare = o.idle === "time" || o.idle === "hide";
  const lines = ly.synced ? [ly.i - 1, ly.i, ly.i + 1].map((i) => (i >= 0 && ly.lines[i]) || null) : [];
  const accent = o.accent === "green" ? "#1ed760" : o.accent === "white" ? "#fff" : tint(now?.color);
  const style = { width: w, height: h, borderRadius: `0 0 ${r}px ${r}px`, "--eq": accent, "--glow": playing && o.glow ? tint(now.color, 0.5) : "transparent" };
  const meter = (label, v) => v != null && (
    <div className="n-meter"><span>{label}</span><div className="n-bar"><div className={v > 85 ? "hot" : ""} style={{ width: v + "%" }} /></div><b>{Math.round(v)}%</b></div>
  );

  // Edit mode: wiggling cards in the dashboard's real layout. Drag to reorder, the badge removes, the tray adds back.
  const outNow = realOuts.find(([, , def]) => def);
  const sum = {
    clock: weather ? `${hm(d)} · ${weather.temp}° ${condition(weather.code)}` : hm(d),
    music: has ? `${now.name} · ${now.artists}` : "While Spotify plays",
    timer: `${tm.mode === "focus" ? "Focus" : "Break"} · ${left(tLeft)}`,
    calendar: !set?.calendars?.length ? "Add a calendar in Settings" : nextEvent ? nextEvent.title : "Nothing coming up",
    pc: pc ? `CPU ${Math.round(pc.cpu)}% · RAM ${Math.round(pc.ram)}%` : "CPU, GPU and RAM",
    listening: today ? `${today.minutes} min today` : "Minutes and streak",
    devices: pcl?.battery?.[0] ? pcl.battery.map((b) => `${b.name} ${b.level == null ? b.text : b.level + "%"}`).join(" · ") : "Controllers, headsets, mice",
    outputs: outNow ? outName(outNow[1])[0] : "Headphones or speakers",
    downloads: dls?.active?.length ? `${dls.active.length} downloading` : "While a browser downloads",
    todos: openTodos.length ? `${openTodos.length} left` : "Your to-do list",
    valorant: "Right after a match",
    steam: steamD?.connected && !steamD.error && !steamD.private ? `${steamD.friends.length} friends online` : "Friends online and in game",
  };
  const name = (id) => NOTCH_SECTIONS.find(([x]) => x === id)?.[1] || id;
  const endEdit = (save) => {
    if (save) {
      fetch(API + "/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notch: { ...o, sections: edit } }) })
        .then(() => emit("settings")).catch(() => {});
    }
    editing.current = false;
    setEdit(null);
  };
  const grab = (id) => (e) => {
    if (e.button !== 0 || e.target.closest(".n-x")) return;
    e.currentTarget.parentElement.setPointerCapture(e.pointerId); // the grid: cards move in the page while you drag, which would drop the capture
    drag.current = { id, last: null };
    setDragging(id);
  };
  const dragMove = (e) => {
    const g = drag.current;
    if (!g) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-sec]")?.dataset.sec;
    if (over === g.last) return;
    g.last = over; // swap once per card you move onto, so big and small cards don't trade places back and forth
    if (!over || over === g.id) return;
    setEdit((l) => {
      const from = l.indexOf(g.id), to = l.indexOf(over), next = l.filter((x) => x !== g.id);
      next.splice(next.indexOf(over) + (from < to ? 1 : 0), 0, g.id);
      return next;
    });
  };
  const drop = () => {
    drag.current = null;
    setDragging(null);
  };
  // Cards glide to their new spot instead of jumping (FLIP).
  useLayoutEffect(() => {
    if (!edit) return;
    for (const el of full.current?.querySelectorAll("[data-sec]") || []) {
      const r = el.getBoundingClientRect(), old = rects.current[el.dataset.sec];
      if (old && (old.left !== r.left || old.top !== r.top)) {
        el.animate([{ transform: `translate(${old.left - r.left}px, ${old.top - r.top}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      rects.current[el.dataset.sec] = r;
    }
  }, [edit]);
  const editor = edit && (
    <div className="n-edit" onClick={stop}>
      <div className="n-ehead">
        <div><b>Edit notch</b><small>Drag to move · − to remove</small></div>
        <button className="n-ereset" onClick={() => setEdit(NOTCH.sections)}>Reset</button>
        <button className="n-ereset" onClick={() => endEdit(false)}>Cancel</button>
        <button className="n-done" onClick={() => endEdit(true)}>Done</button>
      </div>
      <div className="n-egrid" onPointerMove={dragMove} onPointerUp={drop} onPointerCancel={drop} onLostPointerCapture={drop}>
        {edit.map((id) => (
          <div key={id} data-sec={id} className={"n-ed" + (TILES.has(id) ? " tile" : "") + (dragging === id ? " drag" : "")} onPointerDown={grab(id)}>
            <div className="n-edin">
              <button className="n-x" title={"Remove " + name(id)} onClick={() => setEdit((l) => l.filter((x) => x !== id))}>−</button>
              <span className="n-eic"><Icon d={SECTION_ICON[id]} /></span>
              <div className="n-etx"><b>{name(id)}</b><small>{sum[id]}</small></div>
            </div>
          </div>
        ))}
        {!edit.length && <p className="n-eempty">Nothing on the dashboard. Add something below.</p>}
      </div>
      {edit.length < NOTCH_SECTIONS.length && (
        <div className="n-tray">
          <small>Add to the notch</small>
          <div className="n-chips">
            {NOTCH_SECTIONS.filter(([id]) => !edit.includes(id)).map(([id, label]) => (
              <button key={id} className="n-add" onClick={() => setEdit((l) => [...l, id])}><Icon d="plus" />{label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const parts = {
    clock: (
      <div className="n-head">
        <div className="n-time">
          <b>{hm(d)}</b>
          <span>{d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
        </div>
        {weather && (
          <div className="n-wx">
            <WeatherIcon code={weather.code} day={weather.day} />
            <b>{weather.temp}°</b>
            <span>{condition(weather.code)}<br />H {weather.high}° L {weather.low}°</span>
          </div>
        )}
      </div>
    ),
    music: has && (
      <div className="n-music">
        <div className="n-row">
          <button className="n-art" title="Open in Spotify" onClick={() => invoke("open_spotify", { id: now.id })}>
            {cover("n-cover")}<span className="n-sp"><Icon d="spotify" /></span>
          </button>
          <div className="n-info"><b>{now.name}</b><span>{now.artists}</span>{badge}</div>
          {viz(5)}
        </div>
        <div className="n-prog">
          <span>{clock(pos)}</span>
          <div className="n-bar"><div style={{ width: (pos / now.duration_ms) * 100 + "%" }} /></div>
          <span>-{clock(now.duration_ms - pos)}</span>
        </div>
        <div className="n-ctl">
          <div className="n-modes">
            {up?.shuffle && <span title="Shuffle on"><Icon d="shuffle" /></span>}
            {up?.repeat && up.repeat !== "off" && <span title="Repeat on"><Icon d={up.repeat === "track" ? "repeat1" : "repeat"} /></span>}
          </div>
          <div className="n-btns">
            <button onClick={() => press("prev")}><Icon d="prev" /></button>
            <button className="big" onClick={() => press("play")}><Icon d={now.playing ? "pause" : "play"} /></button>
            <button onClick={() => press("next")}><Icon d="next" /></button>
          </div>
          {spot ? (
            <div className="n-volc" title="Spotify volume">
              <button onClick={() => setVolume({ mute: !spot.muted })} title={spot.muted ? "Unmute" : "Mute"}><Icon d={spot.muted ? "mute" : "speaker"} /></button>
              <div className="n-slider" onPointerDown={slide} onPointerMove={slide}>
                <div style={{ width: (spot.muted ? 0 : spot.level * 100) + "%" }} />
              </div>
            </div>
          ) : <div />}
        </div>
        {ly.synced && (
          <div className="n-lyrics">
            {lines.map((l, k) => <p key={l ? l[0] + l[1] : "e" + k} className={k === 1 && l ? "on" : ""}>{l ? l[1] || "♪" : ""}</p>)}
          </div>
        )}
        {up?.next?.[0] && (
          <div className="n-next">
            {up.next[0].image ? <img src={up.next[0].image} draggable={false} /> : <div />}
            <div><small>Up next</small><span>{up.next[0].name}<i> · {up.next[0].artists}</i></span></div>
          </div>
        )}
      </div>
    ),
    timer: (
      <div key="timer" className={"n-tile n-timer " + tm.mode + (tm.end ? " run" : "")}>
        <div className="n-th"><Icon d="timer" />{tm.mode === "focus" ? "Focus" : "Break"}{sessions > 0 && <em>{sessions} today</em>}</div>
        <div className="n-tb">
          <b>{left(tLeft)}</b>
          <button onClick={toggleTimer} title={tm.end ? "Pause" : "Start"}><Icon d={tm.end ? "pause" : "play"} /></button>
          <button onClick={resetTimer} title={tm.end || tm.left != null ? "Reset" : tm.mode === "focus" ? "Switch to break" : "Switch to focus"}>
            <Icon d={tm.end || tm.left != null ? "reset" : "swap"} />
          </button>
        </div>
      </div>
    ),
    calendar: set?.calendars?.length > 0 && (
      <div key="calendar" className="n-tile n-cal">
        <div className="n-th"><Icon d="calendar" />{nextEvent ? "Next up" : "Calendar"}</div>
        <b className="n-tt">{nextEvent ? nextEvent.title : "Nothing coming up"}</b>
        {nextEvent && <span className="n-ts">{soon(nextEvent, ms)}</span>}
      </div>
    ),
    pc: pc && (
      <div key="pc" className="n-tile n-pc">
        <div className="n-th"><Icon d="chip" />PC{pc.gpu_temp != null && <em>GPU {pc.gpu_temp}°</em>}</div>
        {meter("CPU", pc.cpu)}
        {meter("GPU", pc.gpu)}
        {meter("RAM", pc.ram)}
      </div>
    ),
    listening: today && (
      <div key="listening" className="n-tile n-today">
        <div className="n-th"><Icon d="spotify" />Listening</div>
        <b className="n-tt">{today.minutes} min today</b>
        <span className="n-ts">{streak?.current > 0 ? `${streak.current}-day streak` : "No streak yet"}</span>
      </div>
    ),
    steam: steamD?.connected && !steamD.error && (() => {
      const ingame = (steamD.friends || []).find((f) => f.game);
      return (
        <div key="steam" className="n-tile n-steam">
          <div className="n-th"><Icon d="controller" />Steam</div>
          <b className="n-tt">{steamD.private ? steamD.me?.game || "Friends list private" : `${steamD.friends.length} friends online`}</b>
          <span className="n-ts">{ingame ? `${ingame.name} · ${ingame.game}` : steamD.me?.game ? `You're in ${steamD.me.game}` : "Nobody in a game"}</span>
        </div>
      );
    })(),
    devices: pcl?.battery?.length > 0 && (
      <div key="devices" className="n-tile n-devs">
        <div className="n-th"><Icon d="battery" />Batteries</div>
        {pcl.battery.slice(0, 3).map((b) => (
          <div key={b.name} className="n-bat">
            <Icon d={b.kind} /><span>{b.name}</span><b className={b.level != null && b.level <= 20 ? "low" : ""}>{b.level == null ? b.text : `${b.level}%`}</b>
          </div>
        ))}
      </div>
    ),
    outputs: realOuts.length > 1 && (
      <div className="n-outs">
        <div className="n-th"><Icon d="speaker" />Sound output</div>
        <div className="n-outlist">
          {realOuts.slice(0, 6).map(([id, name, def]) => {
            const [main, sub] = outName(name);
            const label = realOuts.filter(([, n]) => outName(n)[0] === main).length > 1 && sub ? sub : main;
            return (
              <button key={id} className={def ? "on" : ""} title={name}
                onClick={(e) => (stop(e), !def && invoke("set_audio_output", { id }).then(loadOuts))}>
                <Icon d={/head|buds|airpods|arctis|hyperx|earphone|wh-|wf-/i.test(name) ? "headset" : "speaker"} /><span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    ),
    downloads: dls && dls.active.length + dls.done.length > 0 && (
      <div className="n-dls">
        <div className="n-th"><Icon d="download" />Downloads{dls.active.length > 0 && <em>{dls.active.length} active</em>}</div>
        {dls.active.map((a, i) => (
          <div key={"a" + i} className="n-dl busy">
            <span className="n-dlname">{a.name || "Downloading"}</span><small>{bytes(a.size)}{a.speed ? ` · ${bytes(a.speed)}/s` : ""}</small>
          </div>
        ))}
        {dls.done.slice(0, 3).map((d) => (
          <button key={d.path + d.at} className="n-dl" title="Show in folder" onClick={(e) => (stop(e), invoke("reveal", { path: d.path }))}>
            <span className="n-dlname">{d.name}</span><small>{bytes(d.size)} · {ago(d.at)}</small><Icon d="folder" />
          </button>
        ))}
      </div>
    ),
    todos: openTodos.length > 0 && (
      <div className="n-todos">
        <div className="n-th"><Icon d="check" />To do<em>{openTodos.length} left</em></div>
        {openTodos.slice(0, 3).map(([t, i]) => (
          <button key={i} className="n-todo" onClick={() => tickTodo(i)}><i />{t.text}</button>
        ))}
      </div>
    ),
    valorant: acts.some((a) => a.id === "val") && (
      <div className="n-acts">
        {acts.filter((a) => a.id === "val").map((a) => (
          <div key={a.id} className="n-act">
            <span className="n-icon" style={{ color: a.tone }}>{a.icon}</span>
            <span className="n-title">{a.label}</span>
            <b style={{ color: a.tone }}>{a.value}</b>
          </div>
        ))}
      </div>
    ),
  };
  // Sections render in the chosen order; neighbouring boxes share a two-column grid.
  const blocks = [];
  for (const id of o.sections) {
    const el = parts[id];
    if (!el) continue;
    const last = blocks[blocks.length - 1];
    if (TILES.has(id) && last?.tiles) last.items.push(el);
    else blocks.push(TILES.has(id) ? { id, tiles: true, items: [el] } : { id, el });
  }
  return (<>
    <div ref={root} className={"notch " + state + " k-" + kind} style={style} onClick={() => setOpen(true)} onWheel={wheel}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()} onAuxClick={(e) => e.button === 1 && has && press("play")}>
      <div className="n-clip">
        {has && now.image && <img className="n-bg" src={now.image} draggable={false} />}
        <div className="n-mini">
          {kind === "music" ? <>
            <span className="n-ring" style={{ "--p": pos / now.duration_ms }}>{cover("n-thumb")}</span>
            {volBar || <span className="n-title" key={line || now.name}>{line || now.name}</span>}
            {viz(4)}
          </> : kind === "act" ? <>
            <span className="n-icon" style={{ color: act.tone }}>{act.icon}</span>
            {volBar || <span className="n-title">{act.label}</span>}
            <b className="n-val" style={{ color: act.tone }}>{act.short}</b>
          </> : <>
            {bare ? null : o.idle === "weather" && weather ? <span className="n-side"><WeatherIcon code={weather.code} day={weather.day} />{weather.temp}°</span>
              : <span className="n-side">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>}
            {volBar || <span className="n-title" />}
            {(!bare || !vol) && <b className="n-side n-clock">{hm(d)}</b>}
            {bare && !vol && <span className="n-title" />}
          </>}
        </div>
        <div className={"n-peek" + (toast ? " n-toast" : "")}>
          {toast?.kind === "shot" ? <>
            <img className="n-shot" src={`${API}/pc/shot/${toast.id}.jpg`} draggable={false} />
            <div className="n-info"><b>Screenshot</b><span>{toast.name}</span></div>
            {shotButtons(toast)}
          </> : toast ? <>
            <span className="n-dlicon"><Icon d="done" /></span>
            <div className="n-info"><b>Downloaded</b><span>{toast.name} · {bytes(toast.size)}</span></div>
            <div className="n-tbtns" onClick={stop}><button title="Show in folder" onClick={() => invoke("reveal", { path: toast.path })}><Icon d="folder" /></button></div>
          </> : <>
            {cover("n-pcover")}
            <div className="n-info"><b>{now?.name}</b><span>{now?.artists}</span>{badge}</div>
            {viz(5)}
          </>}
        </div>
        <div className="n-full" ref={full}>
          {editor || <>
          {signin && (
            <div className="n-acts">
              <button className="n-act n-signin" onClick={() => (now.auth === "no_client_id" ? invoke("open_stats") : invoke("open_url", { url: "http://127.0.0.1:8721/login" }))}>
                <span className="n-icon" style={{ color: signin.tone }}>{signin.icon}</span>
                <span className="n-title">{signin.label}</span>
                <b style={{ color: signin.tone }}>{signin.value}</b>
              </button>
            </div>
          )}
          {priv && (
            <div className="n-acts">
              {[["mic", mics, "#ff9f0a", "microphone"], ["camera", cams, "#30d158", "camera"]].filter(([, apps]) => apps.length).map(([icon, apps, tone, what]) => (
                <div key={icon} className="n-act">
                  <span className="n-icon" style={{ color: tone }}><Icon d={icon} /></span>
                  <span className="n-title">{apps.join(", ")} {apps.length > 1 ? "are" : "is"} using your {what}</span>
                </div>
              ))}
            </div>
          )}
          {o.screenshots && pcl?.shot && (
            <div className="n-shotrow">
              <img src={`${API}/pc/shot/${pcl.shot.id}.jpg`} draggable={false} />
              <div className="n-info"><b>Screenshot</b><span>{ago(pcl.shot.at)}</span></div>
              {shotButtons(pcl.shot)}
            </div>
          )}
          {!has && volBar}
          {blocks.map((b) => (b.tiles ? <div className="n-tiles" key={b.id}>{b.items}</div> : <Fragment key={b.id}>{b.el}</Fragment>))}
          <div className="n-foot">
            {has && up?.device && <span><Icon d={up.kind} />{up.device}</span>}
            <button onClick={openStats}><Icon d="chart" />Stats</button>
          </div>
          </>}
        </div>
      </div>
      {bubble && (
        <div className="n-bubble" style={{ color: bubble.tone }}>
          <span className="n-icon">{bubble.icon}</span><b>{bubble.short}</b>
        </div>
      )}
    </div>
    {priv && (
      <div className={"n-priv" + (state === "gone" ? " solo" : "")} style={{ "--half": w / 2 + "px" }} title={[...mics, ...cams].join(", ")}>
        {cams.length > 0 && <i className="cam" />}
        {mics.length > 0 && <i className="mic" />}
      </div>
    )}
  </>);
}
