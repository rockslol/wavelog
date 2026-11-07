import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { API, get, hidden, notchOptions, useLyrics, usePoll } from "./api";
import { condition, score, signed, WeatherIcon } from "./widgets";

const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor(ms / 1000) % 60)}`;
const left = (ms) => clock(Math.ceil(ms / 1000) * 1000);
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = (s) => new Date(s.length === 10 ? s + "T00:00" : s);
const tint = (c, a = 1) => c && `rgba(${c.map((v) => Math.round(255 * (0.3 + (0.7 * v) / Math.max(...c, 0.01)))).join(",")},${a})`;
const since = (d) => d && new Date(d.replace(" ", "T")).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const ICONS = {
  prev: "M6 6h2v12H6zM9.5 12 18 6v12z",
  next: "M16 6h2v12h-2zM6 6l8.5 6L6 18z",
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
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
  spotify: "M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22zm5.04 15.87a.69.69 0 0 1-.94.23c-2.58-1.58-5.83-1.93-9.65-1.06a.69.69 0 1 1-.3-1.34c4.18-.95 7.77-.54 10.66 1.23.32.2.43.62.23.94zm1.35-3a.86.86 0 0 1-1.18.28c-2.95-1.81-7.45-2.34-10.94-1.28a.86.86 0 1 1-.5-1.65c3.99-1.21 8.94-.62 12.34 1.46.4.25.53.78.28 1.19zm.11-3.13C14.96 8.64 9.12 8.45 5.74 9.47a1.03 1.03 0 1 1-.6-1.97c3.88-1.18 10.33-.95 14.4 1.46a1.03 1.03 0 0 1-1.04 1.78z",
};
const Icon = ({ d }) => <svg viewBox="0 0 24 24"><path fillRule="evenodd" d={ICONS[d] || ICONS.device} /></svg>;
// Each visualizer bar wobbles at its own speed around the real audio level.
const WOBBLE = [[7.1, 0], [9.3, 1.7], [5.7, 3.1], [11.2, 4.4], [8.4, 2.3]];
const NO_TIMER = { mode: "focus", left: null, end: null, done: 0, day: "" };
const TILES = new Set(["timer", "calendar", "pc", "listening"]);

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
  const [sys, setSys] = useState(null);
  const [live, setLive] = useState(false);
  const [meta, setMeta] = useState(null);
  const [up, setUp] = useState(null);
  const [todos, setTodos] = useState(null);
  const [fullH, setFullH] = useState(116);
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
  const acts = [...(signin ? [signin] : []), ...activities(tm, ev, val, ms)];
  const pos = has ? Math.min(now.duration_ms, now.progress_ms + (now.playing ? ms - now.at : 0)) : 0;
  const ly = useLyrics(has ? now.id : null, pos, now?.duration_ms);
  const line = o.lyrics && playing && ly.synced && ly.i >= 0 ? ly.lines[ly.i][1] || "♪" : null;
  const vol = osd ? sys : null; // never 0: "{!has && vol}" would print it

  useEffect(() => {
    const poll = () => !hidden && get("/now").then(fresh).catch(() => setNow(null));
    poll();
    const id = setInterval(poll, 2000);
    const offs = [
      listen("hover", (e) => {
        clearTimeout(timer.current);
        if (e.payload) opts.current.open === "hover" && (timer.current = setTimeout(() => setOpen(true), 180));
        else setOpen(false);
      }),
      listen("reveal", (e) => setReveal(e.payload)),
      listen("sysvol", (e) => (setSys({ level: e.payload[0], muted: e.payload[1] }), opts.current.osd && setOsd(Date.now()))),
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
    invoke("volume", {}).then((r) => r && setSys({ level: r[0], muted: r[1] }));
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
    get(`/track/${now.id}`).then((t) => setMeta({ plays: t.plays, first: t.first })).catch((e) => setMeta(e === 404 ? { plays: 0 } : null));
    if (lastId.current && now.id !== lastId.current && opts.current.peek) {
      setPeek(true);
      lastId.current = now.id;
      const id = setTimeout(() => setPeek(false), 3800);
      return () => clearTimeout(id);
    }
    lastId.current = now.id;
  }, [now?.id]);
  useEffect(() => {
    if (open && has) get("/upnext").then(setUp).catch(() => {});
  }, [open, now?.id]);
  useEffect(() => {
    if (!osd) return;
    const id = setTimeout(() => setOsd(0), 1400);
    return () => clearTimeout(id);
  }, [osd]);
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
  const state = open ? "open" : away ? "gone" : peek && has ? "peek" : kind === "idle" && o.idle === "hide" && !vol ? "gone" : "mini";
  const bubble = (state === "mini" || state === "peek") && (kind === "music" || state === "peek" ? alerts[0] : kind === "act" ? alerts[1] : null);
  const miniW = vol || line ? 340 : kind !== "idle" ? 250 : o.idle === "time" ? 120 : 210;
  const [w, h, r] = { gone: [120, 34, 17], mini: [miniW, 34, 17], peek: [380, 72, 28], open: [460, fullH, 32] }[state];
  useEffect(() => {
    invoke("notch", { w: state === "gone" ? 0 : w + 20 + (bubble ? 2 * 100 : 0), h, autohide: o.autohide });
  }, [w, h, !!bubble, state === "gone", o.autohide]);

  const press = (key) => {
    invoke("media", { key });
    if (key === "play") setNow((n) => ({ ...n, playing: !n.playing, progress_ms: pos, at: Date.now() }));
    fetch(API + "/poke", { method: "POST" }).then((r) => r.json()).then(fresh).catch(() => {});
  };
  const setVolume = (args) => invoke("volume", args).then((r) => r && setSys({ level: r[0], muted: r[1] }));
  const wheel = (e) => {
    if (!o.scroll || Date.now() - lastWheel.current < 50) return;
    lastWheel.current = Date.now();
    setVolume({ delta: e.deltaY < 0 ? 0.04 : -0.04 });
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
    <div className="n-vol"><Icon d={vol.muted ? "mute" : "speaker"} /><div className="n-bar"><div style={{ width: (vol.muted ? 0 : vol.level * 100) + "%" }} /></div><span>{vol.muted ? "Off" : Math.round(vol.level * 100)}</span></div>
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
          {sys ? (
            <div className="n-volc">
              <button onClick={() => setVolume({ mute: !sys.muted })} title={sys.muted ? "Unmute" : "Mute"}><Icon d={sys.muted ? "mute" : "speaker"} /></button>
              <div className="n-slider" onPointerDown={slide} onPointerMove={slide}>
                <div style={{ width: (sys.muted ? 0 : sys.level * 100) + "%" }} />
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
  return (
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
        <div className="n-peek">
          {cover("n-pcover")}
          <div className="n-info"><b>{now?.name}</b><span>{now?.artists}</span>{badge}</div>
          {viz(5)}
        </div>
        <div className="n-full" ref={full}>
          {signin && (
            <div className="n-acts">
              <button className="n-act n-signin" onClick={() => (now.auth === "no_client_id" ? invoke("open_stats") : invoke("open_url", { url: "http://127.0.0.1:8721/login" }))}>
                <span className="n-icon" style={{ color: signin.tone }}>{signin.icon}</span>
                <span className="n-title">{signin.label}</span>
                <b style={{ color: signin.tone }}>{signin.value}</b>
              </button>
            </div>
          )}
          {!has && volBar}
          {blocks.map((b) => (b.tiles ? <div className="n-tiles" key={b.id}>{b.items}</div> : <Fragment key={b.id}>{b.el}</Fragment>))}
          <div className="n-foot">
            {has && up?.device && <span><Icon d={up.kind} />{up.device}</span>}
            <button onClick={openStats}><Icon d="chart" />Stats</button>
          </div>
        </div>
      </div>
      {bubble && (
        <div className="n-bubble" style={{ color: bubble.tone }}>
          <span className="n-icon">{bubble.icon}</span><b>{bubble.short}</b>
        </div>
      )}
    </div>
  );
}
