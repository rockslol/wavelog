import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { API, get, NOTCH, NOTCH_SECTIONS, notchOptions, useLyrics, usePoll } from "./api";
import { About, Advanced } from "./Advanced";
import { installUpdate, startUpdateChecks, useUpdate } from "./update";
import Columns from "./Columns";
import { CalendarHeat, HourHeat } from "./Heat";
import { Rounds, result, score, signed } from "./widgets";

const Open = createContext(() => {});

const RANGES = [["today", "Today"], ["week", "7 days"], ["month", "30 days"], ["year", "12 months"], ["all", "All time"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nice = (s) => {
  const d = new Date(s + "T00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};
const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;
const hours = (m) => `${fmt(m / 60)} ${Math.round(m / 60) === 1 ? "hour" : "hours"}`;
const maxBy = (a, k) => a.reduce((m, x) => (x[k] > (m?.[k] ?? 0) ? x : m), null);

function useApi(paths) {
  const key = JSON.stringify(paths);
  const [state, setState] = useState({ data: null, loading: true, error: false });
  useEffect(() => {
    let live = true, retry = 0;
    const load = (quiet) => {
      clearTimeout(retry);
      if (!quiet) setState((s) => ({ ...s, loading: true }));
      Promise.all(Object.values(paths).map(get))
        .then((r) => live && setState({ data: Object.fromEntries(Object.keys(paths).map((k, i) => [k, r[i]])), loading: false, error: false }))
        .catch(() => {
          if (!live) return;
          setState((s) => ({ ...s, loading: false, error: true }));
          // The backend starts a few seconds after the app; keep trying until it answers.
          retry = setTimeout(() => load(true), 3000);
        });
    };
    load();
    const id = setInterval(() => !document.hidden && load(true), 60000);
    const shown = () => !document.hidden && load(true);
    document.addEventListener("visibilitychange", shown);
    return () => ((live = false), clearInterval(id), clearTimeout(retry), document.removeEventListener("visibilitychange", shown));
  }, [key]);
  return state;
}

function timeline(days, range, year) {
  const by = Object.fromEntries(days.map((x) => [x.day, x.minutes]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = year ? new Date(year, 0, 1)
    : range === "all" ? new Date((days[0]?.day || iso(today)) + "T00:00")
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() - { week: 6, month: 29, year: 364 }[range]);
  const end = year ? new Date(Math.min(today, new Date(year, 11, 31))) : today;
  const unit = year || range === "all" ? "month" : range === "year" ? "week" : "day";
  const out = [];
  for (let d = new Date(start), i = 0; d <= end; d.setDate(d.getDate() + 1), i++) {
    const key = unit === "day" ? i : unit === "week" ? Math.floor(i / 7) : `${d.getFullYear()}-${d.getMonth()}`;
    if (out.at(-1)?.key !== key) {
      const m = MONTHS[d.getMonth()];
      out.push({
        key, value: 0,
        label: unit === "day" ? `${m} ${d.getDate()}` : unit === "week" ? `Week of ${m} ${d.getDate()}` : `${m} ${d.getFullYear()}`,
        tick: unit === "day" ? (range === "week" ? WEEKDAYS[d.getDay()] : i % 7 === 0 ? `${m} ${d.getDate()}` : "")
          : unit === "week" ? (d.getDate() <= 7 ? m : "")
          : year ? m : d.getMonth() === 0 || !out.length ? String(d.getFullYear()) : "",
      });
    }
    out.at(-1).value += by[iso(d)] || 0;
  }
  return out;
}

const hourData = (hours) => hours.map((h) => ({ value: h.minutes, label: `${pad(h.hour)}:00 to ${pad(h.hour + 1)}:00`, tick: h.hour % 3 ? "" : pad(h.hour) }));
const dayData = (days) => days.map((d) => ({ value: d.minutes, label: d.day, tick: d.day.slice(0, 3) }));

const Img = ({ src, round, big }) =>
  src ? <img className={"img" + (round ? " round" : "") + (big ? " big" : "")} src={src} draggable={false} loading="lazy" decoding="async" />
    : <div className={"img" + (round ? " round" : "") + (big ? " big" : "")} />;

// Accent colour for charts and highlights: the most colourful part of the album art.
function setAccent(d) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255, hi = Math.max(R, G, B), lo = Math.min(R, G, B), l = (hi + lo) / 2;
    const sat = hi === lo ? 0 : (hi - lo) / (1 - Math.abs(2 * l - 1)), w = sat * sat * Math.min(l, 1 - l) + 0.001;
    (r += R * w), (g += G * w), (b += B * w), (n += w);
  }
  (r /= n), (g /= n), (b /= n);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), c = hi - lo;
  if (c < 0.06) return;
  const h = (hi === r ? ((g - b) / c) % 6 : hi === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
  const sat = c / (1 - Math.abs(hi + lo - 1));
  const root = document.documentElement.style;
  root.setProperty("--ah", String(Math.round((h + 360) % 360)));
  root.setProperty("--as", Math.round(Math.min(0.85, Math.max(0.45, sat)) * 100) + "%");
}

function Ambient({ images }) {
  const ref = useRef(null);
  const key = images.filter(Boolean).slice(0, 4).join("|");
  useEffect(() => {
    let live = true;
    const load = (src) => new Promise((done) => {
      const im = new Image();
      im.crossOrigin = "anonymous"; // lets us read pixels for the accent colour (i.scdn.co allows it)
      im.onload = () => done(im);
      im.onerror = () => done(null);
      im.src = src;
    });
    Promise.all(key ? key.split("|").map(load) : []).then((ims) => {
      if (!live || !ref.current) return;
      const raw = document.createElement("canvas");
      raw.width = 48;
      raw.height = 30;
      const r = raw.getContext("2d", { willReadFrequently: true });
      r.fillStyle = "#000";
      r.fillRect(0, 0, 48, 30);
      const spots = [[-8, -10], [22, -6], [-2, 12], [26, 14]];
      const ok = ims.filter(Boolean);
      ok.forEach((im, i) => (ok.length === 1 ? r.drawImage(im, 0, -9, 48, 48) : r.drawImage(im, spots[i][0], spots[i][1], 32, 32)));
      try {
        if (ok.length) setAccent(r.getImageData(0, 0, 48, 30).data);
      } catch {}
      // Blur once here instead of a CSS filter, which the GPU would redo on every scroll frame.
      const g = ref.current.getContext("2d");
      g.fillStyle = "#000";
      g.fillRect(0, 0, 96, 60);
      g.filter = "blur(5px) saturate(1.6) brightness(0.55)";
      g.drawImage(raw, -10, -10, 116, 80);
    });
    return () => { live = false; };
  }, [key]);
  return <canvas ref={ref} width={96} height={60} className="ambient" />;
}

// "7 h 56 min" -> 7h 56min with small units; words like "VALORANT" get a smaller size.
function Value({ v }) {
  if (typeof v !== "string" || !/^\d/.test(v)) return v; // only units after a number shrink, "Sep 18" stays as is
  return v.split(/(\d[\d,.]*)/).filter((p) => p.trim()).map((p, i) => (/^\d/.test(p) ? <span key={i}>{p}</span> : <small key={i}>{p.trim()}</small>));
}

// Change against the previous period, e.g. "↑ 12%". Hidden when there's nothing to compare with.
const Delta = ({ v, vs }) => v == null ? null : (
  <span className={"delta " + (Math.abs(v) < 0.005 ? "same" : v > 0 ? "up" : "down")} title={vs}>
    {Math.abs(v) < 0.005 ? "same" : `${v > 0 ? "↑" : "↓"} ${Math.abs(v) >= 9.995 ? Math.round(v * 100).toLocaleString("en-US") : Math.round(Math.abs(v) * 100)}%`}
  </span>
);

const Tile = ({ label, value, sub, hero, className = "", delta, vs }) => (
  <div className={"card tile" + (hero ? " hero" : "") + " " + className}>
    <div className="label">{label}</div>
    <div className={"value" + (typeof value === "string" && !/\d/.test(value) ? " word" : "")} title={typeof value === "string" ? value : undefined}><Value v={value} /></div>
    {(sub || delta != null) && <div className="sub"><Delta v={delta} vs={vs} />{sub}</div>}
  </div>
);

export function Segmented({ options, value, onChange }) {
  const box = useRef(null);
  const [lens, setLens] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = box.current?.querySelector(".on");
      el && setLens({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    document.fonts.ready.then(measure);
  }, [value, options.length]);
  return (
    <div className="segmented glass" ref={box}>
      {lens && <span className="lens" style={lens} />}
      {options.map(([k, l]) => <button key={k} className={k === value ? "on" : ""} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

const TABS = [["overview", "Overview"], ["wrapped", "Wrapped"], ["gaming", "Gaming"], ["valorant", "Valorant"], ["lyrics", "Lyrics"], ["settings", "Settings"]];
const Header = ({ tab, children, title }) => {
  const name = title ?? TABS.find(([k]) => k === tab)?.[1];
  return (name || children) && (
    <div className="page-head">
      {name && <h1>{name}</h1>}
      {children && <div className="page-tools">{children}</div>}
    </div>
  );
};

const NAV_ICONS = {
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  wrapped: "M12 2l2.2 6.3 6.3 2.2-6.3 2.2L12 19l-2.2-6.3-6.3-2.2 6.3-2.2zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  gaming: "M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.3 1.2L14.5 16h-5l-2.3 2.2A2.5 2.5 0 0 1 2.9 17l-.8-4A5 5 0 0 1 7 7zm0 3v1.5H5.5v2H7V15h2v-1.5h1.5v-2H9V10zm8.5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm2.5 2.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
  valorant: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 7.9 7H17v2h2.9A8 8 0 0 1 13 19.9V17h-2v2.9A8 8 0 0 1 4.1 13H7v-2H4.1A8 8 0 0 1 11 4.1V7h2V4.1z",
  lyrics: "M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h-2v-3.1A7 7 0 0 1 5 11z",
  settings: "M10.5 2h3l.5 2.6 1.7.7 2.2-1.5 2.1 2.1-1.5 2.2.7 1.7 2.6.5v3l-2.6.5-.7 1.7 1.5 2.2-2.1 2.1-2.2-1.5-1.7.7-.5 2.6h-3l-.5-2.6-1.7-.7-2.2 1.5-2.1-2.1 1.5-2.2-.7-1.7L2 13.5v-3l2.6-.5.7-1.7-1.5-2.2 2.1-2.1 2.2 1.5 1.7-.7zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
};
Object.assign(NAV_ICONS, {
  back: "M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z",
  "s-general": "M3 6h10v2H3zM17 6h4v2h-4zM13 4h4v6h-4zM3 16h4v2H3zM11 16h10v2H11zM7 14h4v6H7z",
  "s-widgets": "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  "s-notch": "M3 4h18v16H3zm2 2v12h14V6zm3 1h8a2 2 0 0 1 0 4H8a2 2 0 0 1 0-4z",
  "s-look": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 0 16z",
  "s-weather": "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z",
  "s-calendar": "M7 2h2v2h6V2h2v2h3v18H4V4h3zm-1 8v10h12V10z",
  "s-photos": "M3 5h18v14H3zm2 2v10h14V7zm1 9 4-5 3 3 2-2 3 4z",
  "s-productivity": "M4 4h16v16H4zm2 2v12h12V6zm3.5 5.1L11 12.6l3.5-3.5 1.4 1.4-4.9 4.9-2.9-2.9z",
  "s-valorant": NAV_ICONS.valorant,
  "s-advanced": "M3 4h18v16H3zm2 2v12h14V6zm2 2 4 4-4 4-1.4-1.4L8.2 12 5.6 9.4zM12 15h6v2h-6z",
  "s-about": "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM11 10h2v7h-2zM11 7h2v2h-2z",
});
const NavIcon = ({ d }) => <svg viewBox="0 0 24 24"><path fillRule="evenodd" d={NAV_ICONS[d]} /></svg>;

function useSettingsPage() {
  const [page, setPageRaw] = useState(() => {
    try {
      return localStorage.getItem("settingsPage") || "widgets";
    } catch {
      return "widgets";
    }
  });
  useEffect(() => {
    const f = (e) => setPageRaw(e.detail);
    addEventListener("settings-page", f);
    return () => removeEventListener("settings-page", f);
  }, []);
  const setPage = (p) => {
    try {
      localStorage.setItem("settingsPage", p);
    } catch {}
    dispatchEvent(new CustomEvent("settings-page", { detail: p }));
    window.scrollTo(0, 0);
  };
  return [page, setPage];
}

function Sidebar({ tab, setTab, detail }) {
  const now = usePoll("/now", 5000);
  const open = useContext(Open);
  const [page, setPage] = useSettingsPage();
  const up = useUpdate();
  const inSettings = tab === "settings" && !detail;
  const auth = now?.auth && now.auth !== "ok" ? now.auth : null;
  const last = useRef("overview");
  if (tab !== "settings") last.current = tab;
  const item = ([k, label]) => (
    <button key={k} className={tab === k && !detail ? "on" : ""} onClick={() => setTab(k)} title={label}>
      <NavIcon d={k} /><span>{label}</span>
    </button>
  );
  return (
    <aside className="side">
      <div className="brand"><span className="logo"><i /><i /><i /></span><b>Wavelog</b></div>
      <Search />
      {inSettings ? (
        <nav className="side-settings" key="settings">
          <button className="side-back" onClick={() => setTab(last.current)} title="Back">
            <NavIcon d="back" /><span>Settings</span>
          </button>
          {PAGES.map(([id, name]) => (
            <button key={id} className={page === id ? "on" : ""} onClick={() => setPage(id)} title={name}>
              <NavIcon d={"s-" + id} /><span>{name}</span>
            </button>
          ))}
        </nav>
      ) : (
        <nav className="side-main" key="main">{TABS.filter(([k]) => k !== "settings").map(item)}</nav>
      )}
      <div className="grow" />
      {auth && (
        <div className="side-alert warn" title="Spotify">
          <i>!</i>
          <div className="meta">
            <div className="name">{auth === "no_client_id" ? "Finish setup" : "Spotify signed out"}</div>
            <div className="sub">{auth === "no_client_id" ? "Add your Spotify Client ID" : "Plays aren't being recorded"}</div>
          </div>
          <button className="pill" onClick={() => (auth === "no_client_id"
            ? (setTab("settings"), setPage("general"))
            : invoke("open_url", { url: "http://127.0.0.1:8721/login" }))}>{auth === "no_client_id" ? "Set up" : "Sign in"}</button>
        </div>
      )}
      {(up.state === "available" || up.state === "installing") && (
        <button className="side-alert info" onClick={installUpdate} disabled={up.state === "installing"} title="Update">
          <i>↑</i>
          <div className="meta">
            <div className="name">{up.state === "installing" ? `Updating ${Math.round(up.progress * 100)}%` : `Update to ${up.update.version}`}</div>
            <div className="sub">{up.state === "installing" ? "Wavelog restarts when done" : "Click to install and restart"}</div>
          </div>
        </button>
      )}
      {now?.id && !inSettings && (
        <button className="side-now" onClick={() => open({ kind: "track", id: now.id })} title="Now playing">
          <Blurred src={now.image} />
          {now.image ? <img src={now.image} draggable={false} /> : <div />}
          <div className="meta"><div className="name">{now.name}</div><div className="sub">{now.artists}</div></div>
          <i className={"eq" + (now.playing ? " on" : "")}><s /><s /><s /></i>
        </button>
      )}
      {!inSettings && <nav>{item(["settings", "Settings"])}</nav>}
    </aside>
  );
}

// A cover blurred once on a tiny canvas; CSS scales it up. Much cheaper than filter: blur() while scrolling.
function Blurred({ src }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!src) return;
    const im = new Image();
    im.onload = () => {
      const g = ref.current?.getContext("2d");
      if (!g) return;
      g.filter = "blur(3px) saturate(1.5)";
      g.drawImage(im, -6, -6, 52, 52);
    };
    im.src = src;
  }, [src]);
  return <canvas ref={ref} width={40} height={40} className="blurred" />;
}

// Smooth curve through the points that never overshoots them (monotone cubic, Fritsch-Carlson),
// so it can't dip below zero or invent peaks.
function curve(pts) {
  const n = pts.length, f = (v) => v.toFixed(2);
  if (n < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join("");
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      (t[i] = s * a * m[i]), (t[i + 1] = s * b * m[i]);
    }
  }
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3, [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    d += `C${f(x0 + h)},${f(y0 + t[i] * h)} ${f(x1 - h)},${f(y1 - t[i + 1] * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

function Spark({ data }) {
  const id = "s" + useId().replace(/\W/g, "");
  const max = Math.max(1, ...data), n = Math.max(1, data.length - 1);
  const line = curve(data.map((v, i) => [(i / n) * 100, 38 - (v / max) * 34]));
  return (
    <svg className="spark2" viewBox="0 0 100 40" preserveAspectRatio="none">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="g0" /><stop offset="1" className="g1" /></linearGradient></defs>
      <path d={line + "L100,40L0,40Z"} fill={`url(#${id})`} opacity="0.55" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function NowTile({ fallback }) {
  const now = usePoll("/now", 3000);
  const open = useContext(Open);
  const live = !!now?.id;
  const t = live ? now : fallback;
  if (!t) return <div className="card b-now s6 r2"><div className="label">Now playing</div><p className="none">Nothing playing</p></div>;
  return (
    <div className="card b-now s6 r2 clickable" onClick={() => open({ kind: "track", id: t.id })}>
      <Blurred src={t.image} />
      <div className="label">{!live ? "Top track" : now.playing ? "Now playing" : "Paused"}</div>
      <div className="b-now-main">
        {t.image ? <img className="b-now-cover" src={t.image} draggable={false} /> : <div className="b-now-cover" />}
        <div className="b-now-text">
          <div className="b-now-name">{t.name}</div>
          <div className="sub">{t.artists}</div>
          {!live && <div className="sub">{fmt(t.plays)} plays · {fmt(t.minutes)} min</div>}
        </div>
      </div>
      {live && <div className="b-now-bar"><div style={{ width: (now.progress_ms / now.duration_ms) * 100 + "%" }} /></div>}
    </div>
  );
}

function ArtistTile({ a }) {
  const open = useContext(Open);
  if (!a) return null;
  return (
    <div className="card b-artist s4 r2 clickable" onClick={() => open({ kind: "artist", id: a.id })}>
      {a.image && <img className="b-artist-img" src={a.image} draggable={false} loading="lazy" />}
      <div className="b-artist-text">
        <div className="label">Top artist</div>
        <div className="b-big">{a.name}</div>
        <div className="sub">{fmt(a.plays)} plays · {fmt(a.minutes)} min</div>
      </div>
    </div>
  );
}

// Results float above everything (portal to <body>), anchored under the search box, so the sidebar
// can't clip them and their glass blurs what's really behind.
function Search() {
  const open = useContext(Open);
  const [q, setQ] = useState("");
  const [r, setR] = useState(null);
  const [at, setAt] = useState(null);
  const input = useRef(null), panel = useRef(null);
  useEffect(() => {
    if (!q.trim()) return setR(null);
    const id = setTimeout(() => get("/search?q=" + encodeURIComponent(q.trim())).then(setR).catch(() => {}), 200);
    return () => clearTimeout(id);
  }, [q]);
  useLayoutEffect(() => {
    if (!r) return;
    const place = () => {
      const b = input.current?.getBoundingClientRect();
      if (b) setAt({ left: b.left, top: b.bottom + 8, width: Math.max(b.width, 340) });
    };
    place();
    const away = (e) => !panel.current?.contains(e.target) && !input.current?.contains(e.target) && setQ("");
    addEventListener("resize", place);
    addEventListener("pointerdown", away);
    return () => (removeEventListener("resize", place), removeEventListener("pointerdown", away));
  }, [r]);
  const items = r ? [...r.artists.map((x) => ["artist", x]), ...r.tracks.map((x) => ["track", x])] : [];
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [r]);
  useEffect(() => panel.current?.querySelector(".sr-item.on")?.scrollIntoView({ block: "nearest" }), [sel]);
  const pick = ([kind, x]) => (setQ(""), open({ kind, id: x.id }));
  const key = (e) => {
    if (e.key === "Escape") setQ("");
    else if (e.key === "Enter" && items[sel]) pick(items[sel]);
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      setSel((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    }
  };
  const row = (it, i) => (
    <button key={it[0] + it[1].id} className={"sr-item" + (i === sel ? " on" : "")} onClick={() => pick(it)} onPointerEnter={() => setSel(i)}>
      <Img src={it[1].image} round={it[0] === "artist"} />
      <span className="sr-text">
        <b><Mark text={it[1].name} q={q.trim()} /></b>
        <small>{it[0] === "artist" ? "Artist" : it[1].artists}</small>
      </span>
      <span className="sr-plays">{fmt(it[1].plays)}<small>plays</small></span>
    </button>
  );
  const nA = r?.artists.length || 0;
  return (
    <div className="search">
      <input ref={input} className="glass" value={q} placeholder="Search" onChange={(e) => setQ(e.target.value)} onKeyDown={key} />
      {r && at && createPortal(
        <div className="sr" ref={panel} style={at}>
          {items.length ? (
            <>
              {nA > 0 && <div className="sr-head">Artists</div>}
              {items.slice(0, nA).map((it, i) => row(it, i))}
              {r.tracks.length > 0 && <div className="sr-head">Songs</div>}
              {items.slice(nA).map((it, i) => row(it, nA + i))}
            </>
          ) : <p className="sr-none">Nothing called "{q.trim()}" in your plays</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Highlights the part of a name that matches the search.
function Mark({ text, q }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const Status = ({ error }) => <div className="status">{error ? "Can't reach the logger at 127.0.0.1:8721. Is it running?" : "Loading"}</div>;

function Top({ title, items, round, kind }) {
  const open = useContext(Open);
  const max = items[0]?.plays || 1;
  return (
    <section className="card">
      <div className="head"><h3>{title}</h3></div>
      {items.length ? (
        <ol className="list">
          {items.map((x, i) => (
            <li key={x.id} className={kind ? "clickable" : ""} onClick={kind ? () => open({ kind, id: x.id }) : undefined}>
              <span className="rank">{i + 1}</span>
              <Img src={x.image} round={round} />
              <div className="meta">
                <div className="name">{x.name}</div>
                <div className="sub">{x.artists ? x.artists + " · " : ""}{fmt(x.plays)} plays · {fmt(x.minutes)} min</div>
                <div className="meter"><div style={{ width: (x.plays / max) * 100 + "%" }} /></div>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="none">No plays in this range yet.</p>}
    </section>
  );
}

function Binged({ items }) {
  const open = useContext(Open);
  return (
  <section className="card">
    <div className="head"><h3>Binged then dropped</h3><span className="hint">5+ plays in a week, then barely touched for 30+ days</span></div>
    {items.length ? (
      <ol className="list">
        {items.map((x) => (
          <li key={x.id} className="clickable" onClick={() => open({ kind: "track", id: x.id })}>
            <Img src={x.image} />
            <div className="meta">
              <div className="name">{x.name}</div>
              <div className="sub">{x.artists ? x.artists + " · " : ""}{x.binge_plays} plays from {nice(x.binge_start)} to {nice(x.binge_end)}, {x.plays_after} since</div>
            </div>
          </li>
        ))}
      </ol>
    ) : <p className="none">Nothing yet. This shows up once you have a few months of history.</p>}
  </section>
  );
}

function Daily({ items }) {
  const open = useContext(Open);
  return (
    <section className="card">
      <div className="head"><h3>Song of the day</h3><span className="hint">Most played each day</span></div>
      <div className="daily">
        {items.map((x) => (
          <button key={x.day} className="clickable" onClick={() => open({ kind: "track", id: x.id })}>
            <Img src={x.image} big />
            <div className="sub">{nice(x.day)}</div>
            <div className="name">{x.name}</div>
            <div className="sub">{x.plays} {x.plays === 1 ? "play" : "plays"}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

function Gaming({ tab, setTab }) {
  const [range, setRange] = useState("week");
  const { data, loading, error } = useApi({ g: "/gaming?range=" + range });
  const g = data?.g, max = g?.games[0]?.minutes || 1;
  return (
    <>
      <Ambient images={g ? g.soundtrack.map((t) => t.image) : []} />
      <Header tab={tab} setTab={setTab}><Segmented options={RANGES} value={range} onChange={setRange} /></Header>
      {!g ? <Status error={error} /> : (
        <div className={"body" + (loading ? " loading" : "")}>
          <div className="tiles">
            <Tile hero label="Time gaming" value={dur(g.minutes)} sub="Fullscreen games" />
            <Tile label="Sessions" value={fmt(g.sessions)} />
            <Tile label="Games" value={fmt(g.games.length)} />
            <Tile label="Top game" value={g.games[0]?.name || "None"} sub={g.games[0] && dur(g.games[0].minutes)} />
            <Tile label="Longest" value={g.longest ? dur(g.longest.minutes) : "None"} sub={g.longest && `${g.longest.name} · ${nice(g.longest.day)}`} />
          </div>
          {range !== "today" && <Columns title="Gaming over time" data={timeline(g.days, range)} />}
          <section className="card">
            <div className="head"><h3>Games</h3></div>
            {g.games.length ? (
              <ol className="list">
                {g.games.map((x, i) => (
                  <li key={x.exe}>
                    <span className="rank">{i + 1}</span>
                    <div className="meta">
                      <div className="name">{x.name}</div>
                      <div className="sub">{dur(x.minutes)} · {x.sessions} {x.sessions === 1 ? "session" : "sessions"} · longest {dur(x.longest)} · {days(x.days)} · last {nice(x.last.slice(0, 10))} {x.last.slice(11)}</div>
                      <div className="meter"><div style={{ width: (x.minutes / max) * 100 + "%" }} /></div>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="none">No games in this range. Play something fullscreen and it shows up here.</p>}
          </section>
          <div className="grid2">
            <Columns title="By hour of day" data={hourData(g.hours)} />
            <Top title="Your gaming soundtrack" items={g.soundtrack} kind="track" />
          </div>
          <HourHeat grid={g.heat} title="When you game" hint="Hours by weekday, in local time" />
        </div>
      )}
    </>
  );
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "None");
const when = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function ValorantTab({ tab, setTab }) {
  const { data, error } = useApi({ v: "/valorant" });
  const [fresh, setFresh] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("all");
  useEffect(() => setFresh(null), [data]);
  const v = fresh || data?.v;
  const post = (path, body) => fetch(API + path, { method: body ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const refresh = () => (setBusy(true), post("/valorant/refresh").then((r) => r.json()).then(setFresh).catch(() => {}).finally(() => setBusy(false)));
  const turnOn = () => post("/settings", { valorant: true }).then(() => (emit("settings"), refresh()));
  const head = (
    <Header tab={tab} setTab={setTab}>
      {v?.enabled && <Segmented options={[["all", "All modes"], ["comp", "Competitive"]]} value={mode} onChange={setMode} />}
      {v?.enabled && <button className="pill glass" onClick={refresh}>{busy ? "Updating" : "Refresh"}</button>}
    </Header>
  );
  if (!v) return <>{head}<Status error={error} /></>;
  if (!v.enabled) return (
    <>
      {head}
      <div className="body">
        <section className="card wrapped-hero">
          <div className="sub">Valorant tracker</div>
          <h2>Your rank, RR and matches</h2>
          <p className="hint">Reads your own match history from Riot through the Riot Client on this PC, while it's running. No key or website needed. It's an unofficial Riot endpoint that many trackers use, so it can break after a patch.</p>
          <button className="primary" onClick={turnOn}>Turn on</button>
        </section>
      </div>
    </>
  );
  const a = v.assets, tier = a.tiers[v.current?.tier] || {}, peak = a.tiers[v.peak];
  const s = mode === "comp" ? v.competitive : v.all;
  const matches = v.matches.filter((m) => mode === "all" || m.mode === "Competitive");
  return (
    <>
      {head}
      <div className="body">
        <section className="card spotlight valo">
          {tier.icon ? <img className="img big tier" src={tier.icon} draggable={false} /> : <div className="img big" />}
          <div className="grow">
            <div className="sub">{v.riot_id || "Valorant"}</div>
            <h2>{tier.name || "Unranked"}</h2>
            <div className="sub">{v.current?.rr ?? 0} RR · last ranked game <span className={(v.current?.last_change ?? 0) >= 0 ? "up" : "down"}>{signed(v.current?.last_change)}</span>{peak ? ` · peak this act ${peak.name}` : ""}</div>
            <div className="bar rr"><div style={{ width: Math.min(100, v.current?.rr ?? 0) + "%" }} /></div>
            <div className="hint">{v.error || (v.updated ? `Updated ${new Date(v.updated * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "")}</div>
          </div>
        </section>
        <div className="tiles">
          <Tile label="Matches" value={fmt(s.games)} sub={`${s.wins} won`} />
          <Tile label="Win rate" value={pct(s.wins, s.decided)} />
          <Tile label="K/D" value={s.kd.toFixed(2)} />
          <Tile label="Headshot %" value={s.hs + "%"} />
          <Tile label="ADR" value={fmt(s.adr)} sub="Damage per round" />
          <Tile label="ACS" value={fmt(s.acs)} sub="Combat score" />
        </div>
        <section className="card">
          <div className="head"><h3>Matches</h3><span className="hint rtl-legend">Each bar is a round · taller = more kills · faded = you died · <s /> first blood</span></div>
          {matches.length ? (
            <ol className="list matches">
              {matches.map((m) => (
                <li key={m.id} className={"match " + result(m)}>
                  <Img src={a.agents[m.agent_id]?.icon} />
                  <div className="meta">
                    <div className="m-top">
                      <span className="name">{m.map}</span>
                      <span className="m-res">{result(m) === "W" ? "Win" : result(m) === "L" ? "Loss" : "Draw"} {score(m)}</span>
                    </div>
                    <div className="sub">{m.mode} · {m.agent} · {when(m.started_at)} · {Math.round(m.length / 60000)} min</div>
                    {m.round_list?.length > 0 && <Rounds list={m.round_list} />}
                  </div>
                  <div className="kda">
                    <b>{m.kills}<i>/</i>{m.deaths}<i>/</i>{m.assists}</b>
                    <span>{m.shots ? pct(m.headshots, m.shots) : "0%"} HS · {Math.round(m.score / m.rounds)} ACS</span>
                  </div>
                  <div className={"rrc " + (m.rr > 0 ? "up" : m.rr < 0 ? "down" : "")}>{m.rr == null ? "" : <>{signed(m.rr)}<small>RR</small></>}</div>
                </li>
              ))}
            </ol>
          ) : <p className="none">No matches yet.</p>}
        </section>
        <div className="grid2">
          <section className="card">
            <div className="head"><h3>Agents</h3></div>
            <ol className="list">
              {v.agents.map((x) => (
                <li key={x.name}>
                  <Img src={a.agents[x.id]?.icon} />
                  <div className="meta">
                    <div className="name">{x.name}</div>
                    <div className="sub">{x.games} {x.games === 1 ? "match" : "matches"} · {pct(x.wins, x.decided)} won · {x.kd.toFixed(2)} K/D · {x.acs} ACS</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section className="card">
            <div className="head"><h3>Maps</h3></div>
            <ol className="list">
              {v.maps.map((x) => (
                <li key={x.name}>
                  <Img src={a.maps[x.id]?.icon} />
                  <div className="meta">
                    <div className="name">{x.name}</div>
                    <div className="sub">{x.games} {x.games === 1 ? "match" : "matches"} · {pct(x.wins, x.decided)} won</div>
                    <div className="meter"><div style={{ width: (x.decided ? x.wins / x.decided : 0) * 100 + "%" }} /></div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <Songs items={v.songs} />
      </div>
    </>
  );
}

function Songs({ items }) {
  const open = useContext(Open);
  return (
    <section className="card">
      <div className="head"><h3>Songs you win with</h3><span className="hint">Played during a match, best win rate first</span></div>
      {items.length ? (
        <ol className="list">
          {items.map((x) => (
            <li key={x.id} className="clickable" onClick={() => open({ kind: "track", id: x.id })}>
              <Img src={x.image} />
              <div className="meta">
                <div className="name">{x.name}</div>
                <div className="sub">{x.artists} · won {x.wins} of {x.games}</div>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="none">Play Valorant with Spotify on and this fills in.</p>}
    </section>
  );
}

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const MEDIA = {
  prev: "M6 6h2v12H6zM9.5 12 18 6v12z",
  next: "M16 6h2v12h-2zM6 6l8.5 6L6 18z",
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
};

function LyricsView({ tab, setTab }) {
  const now = usePoll("/now", 1000);
  const got = useRef(0);
  useEffect(() => void (got.current = Date.now()), [now]);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => !document.hidden && tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const [optimistic, setOptimistic] = useState(null);
  const playing = optimistic ?? now?.playing;
  const pos = now?.id ? Math.min(now.duration_ms, now.progress_ms + (now.playing ? Date.now() - got.current : 0)) : 0;
  const ly = useLyrics(now?.id, pos, now?.duration_ms);
  const cur = Math.max(ly.i, 0);
  const box = useRef(null);
  const [shift, setShift] = useState(0);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  useLayoutEffect(() => {
    const el = box.current?.children[cur];
    if (el) setShift(el.offsetTop + el.offsetHeight / 2);
  }, [cur, ly.lines.length, now?.id, full]);

  // The current line fills left to right over its duration; CSS runs the animation, React only sets timing.
  const line = ly.synced && ly.i >= 0 ? ly.lines[ly.i] : null;
  const next = line ? ly.lines[ly.i + 1]?.[0] ?? now?.duration_ms : 0;
  const sweep = useMemo(() => (line ? { dur: Math.max(400, next - line[0]), delay: -(pos - line[0]) } : null), [ly.i, now?.id, playing]);

  const toggleFull = () => getCurrentWindow().setFullscreen(!full).then(() => setFull(!full));
  useEffect(() => () => void getCurrentWindow().setFullscreen(false), []);
  useEffect(() => {
    document.documentElement.classList.toggle("lyrics-full", full);
    return () => document.documentElement.classList.remove("lyrics-full");
  }, [full]);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && full && toggleFull();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [full]);
  useEffect(() => {
    if (!full) return setIdle(false);
    let t;
    const wake = () => (setIdle(false), clearTimeout(t), (t = setTimeout(() => setIdle(true), 2500)));
    wake();
    addEventListener("mousemove", wake);
    return () => (clearTimeout(t), removeEventListener("mousemove", wake));
  }, [full]);

  const press = (key) => {
    invoke("media", { key });
    if (key === "play") setOptimistic(!playing);
    setTimeout(() => setOptimistic(null), 2500);
    fetch(API + "/poke", { method: "POST" }).catch(() => {});
  };
  const icon = (d) => <svg viewBox="0 0 24 24"><path d={MEDIA[d]} /></svg>;

  return (
    <div className={"lyr" + (full ? " full" : "") + (idle ? " idle" : "") + (playing ? " playing" : "")}>
      <Ambient images={[now?.image]} />
      <div className="lyr-bg">{now?.image && <><Blurred src={now.image} /><Blurred src={now.image} /></>}</div>
      {full
        ? <button className="pill glass lyr-exit" onClick={toggleFull}>Exit full screen</button>
        : <Header tab={tab} setTab={setTab}><button className="pill glass" onClick={toggleFull}>Full screen</button></Header>}
      {!now?.id ? <div className="status">Nothing playing</div> : (
        <div className="lyr-stage" onDoubleClick={toggleFull}>
          <div className="lyr-player" onDoubleClick={(e) => e.stopPropagation()}>
            {now.image ? <img className="lyr-cover" src={now.image} draggable={false} /> : <div className="lyr-cover" />}
            <div className="lyr-name">{now.name}</div>
            <div className="lyr-artist">{now.artists}</div>
            <div className="lyr-prog">
              <div className="b"><div style={{ width: (pos / now.duration_ms) * 100 + "%" }} /></div>
              <div className="t"><span>{mmss(pos)}</span><span>-{mmss(now.duration_ms - pos)}</span></div>
            </div>
            <div className="lyr-ctl">
              <button onClick={() => press("prev")}>{icon("prev")}</button>
              <button className="big" onClick={() => press("play")}>{icon(playing ? "pause" : "play")}</button>
              <button onClick={() => press("next")}>{icon("next")}</button>
            </div>
          </div>
          <div className="lyr-view">
            {ly.ready && !ly.lines.length ? <div className="lyr-none">No lyrics for this song</div> : (
              <div className={"lyr-lines" + (ly.synced ? "" : " plain")} ref={box}>
                {ly.lines.map(([t, text], k) => {
                  const d = Math.abs(k - cur), on = ly.synced && k === ly.i;
                  return (
                    <p key={k} className={on ? "on" : k < cur ? "past" : ""}
                      style={{ "--d": Math.min(d, 6), translate: `0 ${-shift}px`, transitionDelay: `${Math.min(Math.max(k - cur + 1, 0), 8) * 28}ms` }}>
                      {!text ? <span className="dots"><i /><i /><i /></span>
                        : on && sweep ? (
                          <span className="sweep" key={now.id + ":" + k}
                            style={{ animationDuration: sweep.dur + "ms", animationDelay: sweep.delay + "ms", animationPlayState: playing ? "running" : "paused" }}>{text}</span>
                        ) : text}
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Skipped({ items }) {
  const open = useContext(Open);
  return (
    <section className="card">
      <div className="head"><h3>Most skipped</h3><span className="hint">Changed before 30 seconds</span></div>
      {items.length ? (
        <ol className="list">
          {items.map((x) => (
            <li key={x.id} className="clickable" onClick={() => open({ kind: "track", id: x.id })}>
              <Img src={x.image} />
              <div className="meta">
                <div className="name">{x.name}</div>
                <div className="sub">{x.artists ? x.artists + " · " : ""}{x.skips} {x.skips === 1 ? "skip" : "skips"} · {fmt(x.plays)} plays</div>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="none">No skips in this range.</p>}
    </section>
  );
}

function Overview({ tab, setTab }) {
  const [range, setRange] = useState("week");
  const q = "range=" + range;
  const { data: d, loading, error } = useApi({
    summary: "/summary?" + q, streaks: "/streaks?" + q, days: "/days?" + q, hours: "/hours?" + q, weekdays: "/weekdays?" + q,
    tracks: `/top/tracks?${q}&limit=10`, artists: `/top/artists?${q}&limit=10`, albums: `/top/albums?${q}&limit=10`, binged: `/binged?${q}&limit=5`,
    heat: "/heat?" + q, skips: `/skips?${q}&limit=5`, daily: `/daily?${q}&limit=60`,
  });
  const prev = d?.summary?.prev;
  const change = (k) => (prev && prev[k] > 0 ? (d.summary[k] - prev[k]) / prev[k] : null);
  const vs = { today: "Compared with yesterday up to this time", week: "Compared with the 7 days before",
    month: "Compared with the 30 days before", year: "Compared with the 365 days before" }[range];
  const today = new Date();
  return (
    <>
      <Ambient images={d ? d.albums.map((a) => a.image) : []} />
      <Header tab={tab} setTab={setTab}><Segmented options={RANGES} value={range} onChange={setRange} /></Header>
      {!d ? <Status error={error} /> : (
        <div className={"body bento" + (loading ? " loading" : "")}>
          <NowTile fallback={d.tracks[0]} />
          <div className="card tile hero b-minutes s6">
            <div className="label">Minutes listened</div>
            <div className="value">{fmt(d.summary.minutes)}</div>
            <div className="sub"><Delta v={change("minutes")} vs={vs} />{hours(d.summary.minutes)}</div>
            <Spark data={range === "today" ? d.hours.map((h) => h.minutes) : timeline(d.days, range).map((x) => x.value)} />
          </div>
          <Tile className="s2" label="Plays" value={fmt(d.summary.plays)} delta={change("plays")} vs={vs} />
          <Tile className="s2" label="Tracks" value={fmt(d.summary.tracks)} delta={change("tracks")} vs={vs} />
          <Tile className="s2" label="Artists" value={fmt(d.summary.artists)} delta={change("artists")} vs={vs} />
          <ArtistTile a={d.artists[0]} />
          {range !== "today" && <div className="s8"><Columns title="Listening over time" data={timeline(d.days, range)} /></div>}
          <Tile className="s4" label="Current streak" value={days(d.streaks.current)} sub="Days in a row with music" />
          <Tile className="s4" label="Longest streak" value={days(d.streaks.longest?.days || 0)}
            sub={d.streaks.longest && `${nice(d.streaks.longest.start)} to ${nice(d.streaks.longest.end)}`} />
          {(range === "year" || range === "all") && (
            <div className="s12"><CalendarHeat days={d.days} from={new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1)} to={today} title="Last 12 months" /></div>
          )}
          <div className="s6"><Columns title="By hour of day" data={hourData(d.hours)} /></div>
          <div className="s6"><Columns title="By day of week" data={dayData(d.weekdays)} /></div>
          <div className="s12"><HourHeat grid={d.heat} /></div>
          <div className="s4"><Top title="Top tracks" items={d.tracks} kind="track" /></div>
          <div className="s4"><Top title="Top artists" items={d.artists} round kind="artist" /></div>
          <div className="s4"><Top title="Top albums" items={d.albums} /></div>
          {range !== "today" && d.daily.length > 0 && <div className="s12"><Daily items={d.daily} /></div>}
          <div className="s6"><Binged items={d.binged} /></div>
          <div className="s6"><Skipped items={d.skips} /></div>
        </div>
      )}
    </>
  );
}

function Year({ year }) {
  const q = "year=" + year;
  const { data: d, loading, error } = useApi({
    summary: "/summary?" + q, streaks: "/streaks?" + q, days: "/days?" + q, hours: "/hours?" + q, weekdays: "/weekdays?" + q,
    tracks: `/top/tracks?${q}&limit=5`, artists: `/top/artists?${q}&limit=5`, albums: `/top/albums?${q}&limit=1`, binged: `/binged?${q}&limit=5`,
    heat: "/heat?" + q,
  });
  const [shared, setShared] = useState(null);
  const share = () => {
    setShared({ msg: "Saving" });
    fetch(`${API}/share/wrapped?year=${year}`, { method: "POST" }).then((r) => r.json())
      .then((j) => setShared({ msg: "Saved to Downloads", path: j.path })).catch(() => setShared({ msg: "Couldn't save the image" }));
  };
  if (!d) return <Status error={error} />;
  const s = d.summary, artist = d.artists[0], album = d.albums[0];
  const day = maxBy(d.days, "minutes"), hour = maxBy(d.hours, "minutes"), weekday = maxBy(d.weekdays, "minutes");
  return (
    <div className={"body" + (loading ? " loading" : "")}>
      <Ambient images={[artist?.image, ...d.tracks.map((t) => t.image)]} />
      <section className="card wrapped-hero">
        <div className="share">
          {shared && <span className="hint">{shared.msg}</span>}
          {shared?.path && <button className="link" onClick={() => invoke("reveal", { path: shared.path })}>Show in folder</button>}
          <button className="pill glass" onClick={share}>Save as image</button>
        </div>
        <div className="sub">Your {year} in music</div>
        <div className="big-number">{fmt(s.minutes)}</div>
        <p>minutes listened. That's {hours(s.minutes)}, or {(s.minutes / 1440).toFixed(1)} days.</p>
        <div className="sub">{fmt(s.plays)} plays · {fmt(s.tracks)} tracks · {fmt(s.artists)} artists</div>
      </section>
      {artist && (
        <section className="card spotlight">
          <Img src={artist.image} round big />
          <div>
            <div className="sub">Top artist</div>
            <h2>{artist.name}</h2>
            <div className="sub">{fmt(artist.minutes)} minutes · {fmt(artist.plays)} plays</div>
          </div>
        </section>
      )}
      <div className="grid2">
        <Top title="Top tracks" items={d.tracks} kind="track" />
        <Top title="Top artists" items={d.artists} round kind="artist" />
      </div>
      <div className="tiles">
        <Tile label="Top album" value={album?.name || "None"} sub={album && `${album.artists} · ${fmt(album.plays)} plays`} />
        <Tile label="Busiest day" value={day ? nice(day.day) : "None"} sub={day && `${fmt(day.minutes)} minutes`} />
        <Tile label="Favourite hour" value={hour ? `${pad(hour.hour)}:00` : "None"} sub={hour && `${fmt(hour.minutes)} minutes`} />
        <Tile label="Favourite day" value={weekday?.day || "None"} sub={weekday && `${fmt(weekday.minutes)} minutes`} />
        <Tile label="Longest streak" value={days(d.streaks.longest?.days || 0)}
          sub={d.streaks.longest && `${nice(d.streaks.longest.start)} to ${nice(d.streaks.longest.end)}`} />
      </div>
      <Columns title="Minutes per month" data={timeline(d.days, null, year)} />
      <CalendarHeat days={d.days} from={new Date(year, 0, 1)} to={new Date(Math.min(new Date(), new Date(year, 11, 31)))} title={`${year} in days`} />
      <HourHeat grid={d.heat} />
      <div className="grid2">
        <Columns title="By hour of day" data={hourData(d.hours)} />
        <Columns title="By day of week" data={dayData(d.weekdays)} />
      </div>
      <Binged items={d.binged} />
    </div>
  );
}

function Wrapped({ tab, setTab }) {
  const { data, error } = useApi({ years: "/years" });
  const [year, setYear] = useState(null);
  const y = year || data?.years[0];
  return (
    <>
      <Header tab={tab} setTab={setTab}>
        {y && <Segmented options={data.years.map((v) => [v, String(v)])} value={y} onChange={setYear} />}
      </Header>
      {!data ? <Status error={error} /> : !y ? <div className="status">No plays yet.</div> : <Year key={y} year={y} />}
    </>
  );
}

function months(list) {
  if (!list.length) return [];
  const by = Object.fromEntries(list.map((m) => [m.month, m.plays]));
  const [y, m] = list[0].month.split("-").map(Number), now = new Date(), out = [];
  for (let d = new Date(y, m - 1, 1); d <= now; d.setMonth(d.getMonth() + 1)) {
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    out.push({ value: by[key] || 0, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, tick: d.getMonth() % 3 ? "" : MONTHS[d.getMonth()] });
  }
  return out;
}

function Detail({ kind, id, tab, setTab, back }) {
  const open = useContext(Open);
  const { data, error } = useApi({ x: `/${kind}/${id}` });
  const x = data?.x;
  return (
    <>
      <Header tab={tab} setTab={setTab} title=""><button className="pill glass" onClick={back}>Back</button></Header>
      {!x ? <Status error={error} /> : (
        <div className="body">
          <Ambient images={[x.image]} />
          <section className="card spotlight">
            <Img src={x.image} round={kind === "artist"} big />
            <div>
              <div className="sub">{kind === "track" ? "Track" : "Artist"}</div>
              <h2>{x.name}</h2>
              <div className="sub">
                {kind === "track" ? x.artists.map((a, i) => (
                  <span key={a.id}>{i ? ", " : ""}<button className="link" onClick={() => open({ kind: "artist", id: a.id })}>{a.name}</button></span>
                )) : `${fmt(x.tracks)} songs`}
                {kind === "track" && x.album && ` · ${x.album}`}
              </div>
            </div>
          </section>
          <div className="tiles">
            <Tile label="Plays" value={fmt(x.plays)} />
            <Tile label="Minutes" value={fmt(x.minutes)} sub={hours(x.minutes)} />
            <Tile label="First played" value={x.first ? nice(x.first.slice(0, 10)) : "Never"} sub={x.first?.slice(11, 16)} />
            <Tile label="Last played" value={x.last ? nice(x.last.slice(0, 10)) : "Never"} sub={x.last?.slice(11, 16)} />
            <Tile label="Peak week" value={x.peak ? `${fmt(x.peak.plays)} plays` : "None"} sub={x.peak && `Week of ${nice(x.peak.start)}`} />
            {kind === "track" && <Tile label="Skipped" value={fmt(x.skips)} sub={x.skips ? `${Math.round((x.skips / (x.skips + x.plays)) * 100)}% of the time` : ""} />}
          </div>
          <Columns title="Plays per month" data={months(x.months)} unit="plays" />
          {kind === "artist" && <Top title="Top tracks" items={x.top} kind="track" />}
        </div>
      )}
    </>
  );
}

const WIDGETS = [["widget", "Now playing"], ["lyrics", "Lyrics"], ["calendar", "Calendar"], ["photos", "Photos"], ["weather", "Weather"], ["system", "PC monitor"],
  ["clock", "Clock"], ["countdown", "Countdown"], ["todo", "To do"], ["timer", "Focus timer"], ["note", "Note"], ["valorant", "Valorant"]];
const ALL = [...WIDGETS, ["stack", "Widget stack"], ["notch", "Notch"]];

const SIZES = [["s", "Small"], ["m", "Medium"], ["l", "Large"]];

function applyWidgets(s) {
  const list = s.widgets.map((w) => [w, s.sizes?.[w] || "m"]);
  try {
    localStorage.setItem("widgets", JSON.stringify(list));
    localStorage.setItem("scale", String(s.scale ?? 1));
  } catch {}
  return invoke("set_widgets", { list, scale: s.scale ?? 1, overlay: s.overlay || [], tabY: s.tab_y ?? 0.7 });
}

export const Switch = ({ on, onChange }) => (
  <button className={"switch" + (on ? " on" : "")} role="switch" aria-checked={on} onClick={onChange}><span /></button>
);

const PAGES = [["general", "General"], ["widgets", "Widgets"], ["notch", "Notch"], ["look", "Appearance"], ["weather", "Weather"], ["calendar", "Calendar"],
  ["photos", "Photos"], ["productivity", "Productivity"], ["valorant", "Valorant"],
  ["advanced", "Advanced"], ["about", "About"]];

export const Row = ({ label, hint, children }) => (
  <div className="row">
    <div className="row-label">{label}{hint && <span className="hint">{hint}</span>}</div>
    {children}
  </div>
);

const lfProgress = (l) => (l.phase === "Matching songs to Spotify" ? `${fmt(l.done)} of ${fmt(l.total)} songs`
  : l.phase === "Adding plays" ? `${fmt(l.done)} of ${fmt(l.total)} scrobbles · ${fmt(l.added)} added, ${fmt(l.known)} already here`
  : `${fmt(l.done)} of ${fmt(l.total)} scrobbles read`);
const lfDone = (l) => (l.last_run
  ? `Last synced ${new Date(l.last_run * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}${l.missing_songs ? ` · ${fmt(l.missing_songs)} songs not found on Spotify` : ""}`
  : "Not imported yet");

function Settings({ tab, setTab }) {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [boot, setBoot] = useState(null);
  const [page, setPage] = useSettingsPage();
  useEffect(() => {
    isEnabled().then(setBoot).catch(() => {});
  }, []);
  const toggleBoot = () => (boot ? disable() : enable()).then(() => isEnabled().then(setBoot));
  useEffect(() => {
    let stop = false, retry;
    const load = () => get("/settings").then((j) => !stop && (setS(j), setMsg((m) => (m === "offline" ? "" : m))))
      .catch(() => !stop && (setMsg("offline"), (retry = setTimeout(load, 3000))));
    load();
    const off = listen("settings", () => get("/settings").then((j) => setS((s) => s && { ...s, todos: j.todos })).catch(() => {}));
    return () => ((stop = true), clearTimeout(retry), off.then((f) => f()));
  }, []);
  const [lf, setLf] = useState(null);
  const [kick, setKick] = useState(0);
  useEffect(() => {
    let stop = false, id;
    const load = () => get("/lastfm").then((j) => !stop && (setLf(j), (id = setTimeout(load, j.running ? 1500 : 30000)))).catch(() => !stop && (id = setTimeout(load, 30000)));
    load();
    return () => ((stop = true), clearTimeout(id));
  }, [s?.lastfm_user, s?.lastfm_key, kick]);
  const importLastfm = (full) => fetch(API + `/lastfm/sync?full=${full}`, { method: "POST" }).then((r) => r.json()).then((j) => (setLf(j), setKick((k) => k + 1))).catch(() => {});
  const [exported, setExported] = useState(null);
  const exportCsv = () => {
    setExported({ msg: "Exporting" });
    fetch(API + "/export", { method: "POST" }).then((r) => r.json())
      .then((j) => setExported({ msg: `Saved ${fmt(j.rows)} plays to Downloads`, path: j.path })).catch(() => setExported({ msg: "Couldn't export" }));
  };
  const save = async (next) => {
    setMsg("Saving");
    const r = await fetch(API + "/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    const j = r && (await r.json().catch(() => null));
    if (!r?.ok) return setMsg(j?.detail || "Couldn't save");
    setS(j);
    setMsg("Saved");
    applyWidgets(j);
    emit("settings");
  };
  const set = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    save(next);
  };
  const submit = () => save({
    ...s, calendars: s.calendars.map((c) => c.trim()).filter(Boolean), photo_seconds: Math.max(5, +s.photo_seconds || 30),
    countdowns: s.countdowns.map((c) => c.trim()).filter(Boolean), todos: s.todos.filter((t) => t.text.trim()),
    pomodoro: s.pomodoro.map((m, i) => Math.max(1, +m || [25, 5][i])),
  });
  const field = (k) => ({ value: s[k] ?? "", onChange: (e) => setS({ ...s, [k]: e.target.value }), onBlur: submit });
  const lines = (k) => ({ value: s[k].join("\n"), onChange: (e) => setS({ ...s, [k]: e.target.value.split("\n") }), onBlur: submit });
  const flip = (k, id) => set({ [k]: s[k].includes(id) ? s[k].filter((x) => x !== id) : [...s[k], id] });
  const slider = (k, min, max) => ({
    type: "range", min, max, step: 0.05, value: s[k] ?? 1,
    onChange: (e) => setS({ ...s, [k]: +e.target.value }), onPointerUp: (e) => set({ [k]: +e.target.value }), onKeyUp: (e) => set({ [k]: +e.target.value }),
  });

  const n = notchOptions(s);
  const [mons, setMons] = useState([]);
  useEffect(() => {
    invoke("monitors").then(setMons).catch(() => {});
  }, []);
  const setN = (patch) => set({ notch: { ...n, ...patch } });
  const nSwitch = (k) => <Switch on={n[k]} onChange={() => setN({ [k]: !n[k] })} />;
  const sections = [...n.sections.filter((id) => NOTCH_SECTIONS.some(([x]) => x === id)), ...NOTCH_SECTIONS.map(([id]) => id).filter((id) => !n.sections.includes(id))];
  const moveSection = (id, by) => {
    const list = [...n.sections], i = list.indexOf(id), j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setN({ sections: list });
  };
  const flipSection = (id) => setN({ sections: n.sections.includes(id) ? n.sections.filter((x) => x !== id) : [...n.sections, id] });

  const pages = s && {
    advanced: <Advanced />,
    about: <About />,
    notch: <>
      {!s.widgets.includes("notch") && (
        <section className="card group">
          <Row label="Notch" hint="Turned off. Turn it on to see your changes"><Switch on={false} onChange={() => flip("widgets", "notch")} /></Row>
        </section>
      )}
      <h4>Small notch</h4>
      <section className="card group">
        <Row label="When nothing is playing" hint={n.idle === "hide" ? "Only shows up for music, alerts and volume" : "What the notch shows when idle"}>
          <Segmented options={[["weather", "Weather"], ["date", "Date"], ["time", "Time"], ["hide", "Hide"]]} value={n.idle} onChange={(v) => setN({ idle: v })} />
        </Row>
        {mons.length > 1 && (
          <Row label="Screen" hint="Which screen the notch sits on">
            <Segmented options={[["", "Main"], ...mons.filter((m) => !m[1]).map((m, i) => [m[0], `Screen ${i + 2} · ${m[2]}×${m[3]}`])]}
              value={mons.some((m) => m[0] === n.monitor && !m[1]) ? n.monitor : ""} onChange={(v) => setN({ monitor: v })} />
          </Row>
        )}
        <Row label="Hide over apps" hint="Hidden while a window is under it, so it never covers tabs or buttons. Rest the mouse on the top edge of the screen to bring it back">{nSwitch("autohide")}</Row>
        <Row label="Lyrics line" hint="The current lyric replaces the song name">{nSwitch("lyrics")}</Row>
        <Row label="Alerts" hint="Focus timer, events starting soon and match results">{nSwitch("alerts")}</Row>
        <Row label="Song change pop" hint="Grows with the cover for a moment when the song changes">{nSwitch("peek")}</Row>
        <Row label="Volume pop-up" hint="Shows a volume bar when the volume changes">{nSwitch("osd")}</Row>
      </section>
      <h4>Look</h4>
      <section className="card group">
        <Row label="Accent colour" hint="Progress ring, bars and lyrics">
          <Segmented options={[["album", "Album"], ["green", "Green"], ["white", "White"]]} value={n.accent} onChange={(v) => setN({ accent: v })} />
        </Row>
        <Row label="Audio bars" hint="Move with Spotify's sound">{nSwitch("viz")}</Row>
        <Row label="Glow" hint="Album-coloured glow while music plays">{nSwitch("glow")}</Row>
      </section>
      <h4>Dashboard</h4>
      <section className="card group">
        <Row label="Open with" hint={n.open === "hover" ? "Opens when you rest the mouse on it" : "Opens when you click it"}>
          <Segmented options={[["hover", "Hover"], ["click", "Click"]]} value={n.open} onChange={(v) => setN({ open: v })} />
        </Row>
        <Row label="Scroll for volume" hint="Scroll on the notch to change the Windows volume">{nSwitch("scroll")}</Row>
      </section>
      <section className="card group notch-order">
        {sections.map((id) => {
          const name = NOTCH_SECTIONS.find(([x]) => x === id)[1], on = n.sections.includes(id), i = n.sections.indexOf(id);
          return (
            <Row key={id} label={name}>
              <div className="size-picker">
                {on && <>
                  <button className="chip" disabled={i === 0} onClick={() => moveSection(id, -1)} aria-label="Move up">↑</button>
                  <button className="chip" disabled={i === n.sections.length - 1} onClick={() => moveSection(id, 1)} aria-label="Move down">↓</button>
                </>}
                <Switch on={on} onChange={() => flipSection(id)} />
              </div>
            </Row>
          );
        })}
      </section>
      <p className="hint foot-note">Dashboard sections show top to bottom in this order. Focus timer, Next event, PC load and Listening today are small boxes; next to each other they share a row of two. <button className="link" onClick={() => setN(NOTCH)}>Reset the notch</button></p>
    </>,
    general: <>
      <section className="card group">
        {boot !== null && <Row label="Start with Windows" hint="Widgets and the logger start when you sign in"><Switch on={boot} onChange={toggleBoot} /></Row>}
        <Row label="Show or hide widgets" hint="Works anywhere, also from the tray icon"><kbd>Ctrl+Alt+S</kbd></Row>
      </section>
      <h4>Spotify</h4>
      <section className="card group">
        <label className="field"><span>Client ID from developer.spotify.com/dashboard</span><input {...field("client_id")} placeholder="Paste your app's Client ID" /></label>
        <div className="field"><span>Redirect URI to add in the dashboard</span><code className="mono">{s.redirect}</code></div>
      </section>
      <h4>Last.fm</h4>
      <section className="card group">
        <label className="field"><span>Last.fm username</span><input {...field("lastfm_user")} placeholder="Your Last.fm username" /></label>
        <label className="field"><span>API key, make one free at last.fm/api/account/create</span><input {...field("lastfm_key")} placeholder="32 letters and numbers" /></label>
        {lf?.connected && (
          <Row label={lf.running ? lf.phase || "Starting" : lf.error ? "Import stopped" : `${fmt(lf.plays)} plays from Last.fm`}
            hint={lf.running ? lfProgress(lf) : lf.error || lfDone(lf)}>
            <button className="pill glass" disabled={lf.running} onClick={() => importLastfm(!lf.last_run)}>{lf.last_run ? "Sync now" : "Import"}</button>
          </Row>
        )}
        {lf?.running && <div className="lf-bar"><div style={{ width: (lf.total ? (lf.done / lf.total) * 100 : 3) + "%" }} /></div>}
      </section>
      <p className="hint foot-note">Adds every scrobble to your stats, matched to Spotify songs. Plays you already have are skipped, so nothing counts twice. After the first import it syncs new scrobbles every 30 minutes, including from your phone while this PC was off.</p>
      <h4>Your data</h4>
      <section className="card group">
        <Row label="Export plays to CSV" hint={exported?.msg || "Every play, as a spreadsheet in Downloads"}>
          <div className="size-picker">
            {exported?.path && <button className="link" onClick={() => invoke("reveal", { path: exported.path })}>Show in folder</button>}
            <button className="pill glass" onClick={exportCsv}>Export</button>
          </div>
        </Row>
      </section>
    </>,
    widgets: <>
      <section className="card group">
        {ALL.map(([id, name]) => {
          const on = s.widgets.includes(id);
          return (
            <div className="widget-row" key={id}>
              <Row label={name} hint={id === "notch" ? "Time, weather and what's playing at the top of the screen. Hover it for your dashboard" : undefined}><Switch on={on} onChange={() => flip("widgets", id)} /></Row>
              {on && (
                <div className="widget-opts">
                  {id !== "notch" && <Segmented options={SIZES} value={s.sizes?.[id] || "m"} onChange={(v) => set({ sizes: { ...s.sizes, [id]: v } })} />}
                  {id === "notch" && <button className="chip" onClick={() => setPage("notch")}>Customize</button>}
                  <button className={"chip" + (s.overlay.includes(id) ? " on" : "")} onClick={() => flip("overlay", id)}>Over games</button>
                </div>
              )}
            </div>
          );
        })}
      </section>
      {s.widgets.includes("stack") && <>
        <h4>Widget stack</h4>
        <section className="card group">
          <Row label="Widgets in the stack" hint="Scroll on the stack to flip">
            <div className="chips">
              {WIDGETS.map(([id, name]) => <button key={id} className={"chip" + (s.stack.includes(id) ? " on" : "")} onClick={() => flip("stack", id)}>{name}</button>)}
            </div>
          </Row>
        </section>
      </>}
      <p className="hint foot-note">Widgets sit on the desktop, under your apps. Over games keeps a widget on screen while a game is fullscreen, solid instead of glass, and clicks go through to the game. Set the game to Windowed Fullscreen (borderless).</p>
    </>,
    look: <>
      <section className="card group">
        <Row label="Glass tint" hint="How dark the glass is">
          <div className="size-picker"><span className="hint">Clear</span><input {...slider("tint", 0, 1)} /><span className="hint">Tinted</span></div>
        </Row>
        <Row label="Widget size" hint={`${Math.round((s.scale ?? 1) * 100)}%`}><input {...slider("scale", 0.6, 1.2)} /></Row>
        <Row label="Album colour glass" hint="Now playing and Lyrics take the colour of the cover"><Switch on={s.cover_glass} onChange={() => set({ cover_glass: !s.cover_glass })} /></Row>
        <Row label="Lyrics in Now playing"><Switch on={s.now_lyrics} onChange={() => set({ now_lyrics: !s.now_lyrics })} /></Row>
        <Row label="Lock positions" hint="Off: drag widgets, they snap to each other and the screen edge"><Switch on={s.locked} onChange={() => set({ locked: !s.locked })} /></Row>
      </section>
    </>,
    weather: <>
      <section className="card group">
        <label className="field"><span>City{s.place ? ` · showing ${s.place}` : ""}</span><input {...field("city")} placeholder="Budapest" /></label>
        <Row label="Units"><Segmented options={[["c", "°C"], ["f", "°F"]]} value={s.fahrenheit ? "f" : "c"} onChange={(v) => set({ fahrenheit: v === "f" })} /></Row>
      </section>
    </>,
    calendar: <>
      <section className="card group">
        <label className="field"><span>Calendar links (.ics or webcal), one per line</span><textarea rows={4} {...lines("calendars")} /></label>
      </section>
      <p className="hint foot-note">iPhone: Calendar, Calendars, ⓘ next to a calendar, Public Calendar, Share Link.</p>
    </>,
    photos: <>
      <section className="card group">
        <label className="field"><span>iCloud shared album link</span><input {...field("album")} placeholder="https://www.icloud.com/sharedalbum/#..." /></label>
        <label className="field"><span>Or a folder on this PC</span><input {...field("folder")} placeholder="D:\Pictures\Favourites" /></label>
        <label className="field"><span>Seconds per photo</span><input type="number" min="5" {...field("photo_seconds")} /></label>
      </section>
      <p className="hint foot-note">The iCloud album needs Public Website turned on.</p>
    </>,
    productivity: <>
      <h4>Countdown</h4>
      <section className="card group">
        <label className="field"><span>One per line: date, then a name. The nearest shows biggest</span>
          <textarea rows={3} {...lines("countdowns")} placeholder="2026-12-24 Christmas" /></label>
      </section>
      <h4>To do</h4>
      <section className="card group">
        <label className="field"><span>One task per line. Click a task on the widget to tick it</span>
          <textarea rows={4} value={s.todos.map((t) => t.text).join("\n")} onBlur={submit}
            onChange={(e) => setS({ ...s, todos: e.target.value.split("\n").map((text) => ({ text, done: s.todos.find((t) => t.text === text)?.done || false })) })} />
        </label>
        {s.todos.some((t) => t.done) && <button className="link" onClick={() => set({ todos: s.todos.filter((t) => !t.done) })}>Remove ticked tasks</button>}
      </section>
      <h4>Note</h4>
      <section className="card group">
        <label className="field"><span>Shows on the Note widget</span><textarea rows={4} {...field("note")} /></label>
      </section>
      <h4>Focus timer</h4>
      <section className="card group">
        <div className="field-row">
          {["Focus minutes", "Break minutes"].map((label, i) => (
            <label className="field" key={label}><span>{label}</span>
              <input type="number" min="1" value={s.pomodoro[i]} onBlur={submit}
                onChange={(e) => setS({ ...s, pomodoro: s.pomodoro.map((m, k) => (k === i ? e.target.value : m)) })} />
            </label>
          ))}
        </div>
      </section>
    </>,
    valorant: <>
      <section className="card group">
        <Row label="Valorant tracker" hint="Rank, RR, matches and rounds, read from the Riot Client on this PC"><Switch on={s.valorant} onChange={() => set({ valorant: !s.valorant })} /></Row>
        <Row label="Tab panel" hint="Hold Tab in a match for today, this map, this agent and your last match. Needs Windowed Fullscreen"><span className="hint">{s.valorant ? "On" : "Needs the tracker"}</span></Row>
        <Row label="Tab panel height" hint={`${Math.round((s.tab_y ?? 0.7) * 100)}% down the screen, centred. Raise it for Skirmish, lower it for 5v5`}>
          <input {...slider("tab_y", 0.3, 0.9)} value={s.tab_y ?? 0.7} />
        </Row>
        <Row label="Valorant widget" hint="Turn it on in Widgets, and Over games to keep it up in a match">
          <button className="pill glass" onClick={() => setPage("widgets")}>Widgets</button>
        </Row>
      </section>
      <p className="hint foot-note">Uses the same unofficial Riot endpoints as other desktop trackers, only for your own account. It never touches the game, but a patch can break it.</p>
    </>,
  };
  return (
    <>
      <Header tab={tab} setTab={setTab} title={PAGES.find((p) => p[0] === page)?.[1] || "Settings"}>
        {msg && msg !== "offline" && <span className="hint">{msg}</span>}
      </Header>
      {!s ? <Status error={msg === "offline"} /> : (
        <div className="body settings-wrap">
          <nav className="set-nav card">
            {PAGES.map(([id, name]) => (
              <button key={id} className={page === id ? "on" : ""} onClick={() => setPage(id)}>{name}</button>
            ))}
          </nav>
          <div className="set-page" key={page}>
            {pages[page]}
          </div>
        </div>
      )}
    </>
  );
}

export default function Stats() {
  const hash = location.hash.slice(1).split("/");
  const [tab, setTabRaw] = useState(["overview", "wrapped", "gaming", "valorant", "lyrics", "settings"].includes(hash[0]) ? hash[0] : "overview");
  const [detail, setDetail] = useState(hash[1] ? { kind: hash[0], id: hash[1] } : null);
  const setTab = (t) => (setDetail(null), setTabRaw(t));
  useEffect(() => {
    let list = [["widget", "m"]];
    try {
      list = (JSON.parse(localStorage.getItem("widgets")) || list).map((w) => (Array.isArray(w) ? w : [w, "m"]));
    } catch {}
    invoke("set_widgets", { list, scale: +localStorage.getItem("scale") || 1 });
    startUpdateChecks();
    let stop = false;
    const sync = () => get("/settings").then(applyWidgets).catch(() => !stop && setTimeout(sync, 5000));
    sync();
    const offs = [listen("open-settings", () => setTab("settings")), listen("open-detail", (e) => (setDetail(e.payload), window.scrollTo(0, 0)))];
    return () => ((stop = true), offs.forEach((o) => o.then((f) => f())));
  }, []);
  const View = { overview: Overview, wrapped: Wrapped, gaming: Gaming, valorant: ValorantTab, lyrics: LyricsView, settings: Settings }[tab];
  const open = (d) => (setDetail(d), window.scrollTo(0, 0));
  return (
    <Open.Provider value={open}>
      <div className="shell">
        <Sidebar tab={tab} setTab={setTab} detail={detail} />
        <main className="stats" key={detail ? detail.kind + detail.id : tab}>
          {detail ? <Detail key={detail.kind + detail.id} {...detail} tab={tab} setTab={setTab} back={() => setDetail(null)} /> : <View tab={tab} setTab={setTab} />}
        </main>
      </div>
    </Open.Provider>
  );
}
