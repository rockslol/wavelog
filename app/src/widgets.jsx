import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { API, hidden, useLyrics, usePoll, useSize } from "./api";
import Frame from "./Frame";

const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = (s) => new Date(s.length === 10 ? s + "T00:00" : s);
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function useTick(ms) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => !hidden && tick((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const Empty = ({ children }) => <p className="none">{children}</p>;

export function Lyrics() {
  const size = useSize();
  const now = usePoll("/now", 500);
  const { ready, synced, lines, i } = useLyrics(now?.id, now?.progress_ms ?? 0, now?.duration_ms);
  const [before, after] = { s: [0, 2], m: [0, 3], l: [1, 6] }[size];
  const from = Math.max(i - before, 0);
  return (
    <Frame className={"lyrics" + (synced ? "" : " plain")} hue={now?.color}>
      <div className="head-line">
        {now?.image && <img src={now.image} draggable={false} />}
        <span>{now?.id ? `${now.name} · ${now.artists}` : "Lyrics"}</span>
      </div>
      {!now?.id ? <Empty>Nothing playing</Empty>
        : !ready ? null
        : !lines.length ? <Empty>No lyrics found</Empty>
        : <div className="lines">
          {lines.slice(from, Math.max(i, 0) + after).map(([t, text], k) => (
            <p key={t + text + k} className={synced && from + k === i ? "on" : ""}>{text || "♪"}</p>
          ))}
        </div>}
    </Frame>
  );
}

function when(e) {
  const s = parse(e.start), today = new Date();
  const days = Math.round((new Date(s).setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86400000);
  const day = days <= 0 ? "" : days === 1 ? "Tomorrow, " : s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + ", ";
  return day + (e.all_day ? "All day" : `${hm(s)} to ${hm(parse(e.end))}`);
}

function Month({ events }) {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const marked = new Set(events.map((e) => dayKey(parse(e.start))));
  return (
    <div className="month">
      <div className="month-name">{d.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
      <div className="grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((w, k) => <span key={k} className="dow">{w}</span>)}
        {Array.from({ length: lead }, (_, k) => <span key={"x" + k} />)}
        {Array.from({ length: days }, (_, k) => {
          const day = new Date(d.getFullYear(), d.getMonth(), k + 1);
          return <span key={k} className={(k + 1 === d.getDate() ? "today " : "") + (marked.has(dayKey(day)) ? "has" : "")}>{k + 1}</span>;
        })}
      </div>
    </div>
  );
}

export function Calendar() {
  const size = useSize();
  const ev = usePoll("/calendar", 300000);
  const set = usePoll("/settings", 60000);
  useTick(60000);
  const d = new Date();
  const next = (ev || []).filter((e) => parse(e.end) > d).slice(0, { s: 1, m: 3, l: 3 }[size]);
  const list = set && !set.calendars.length ? <Empty>Add a calendar link in Settings</Empty>
    : ev === null ? <Empty>Calendar unavailable</Empty>
    : ev && !next.length ? <Empty>Nothing in the next two weeks</Empty>
    : next.map((e) => (
      <div className="event" key={e.start + e.title}>
        <div className="name">{e.title}</div>
        <div className="sub">{when(e)}</div>
      </div>
    ));
  return (
    <Frame className="calendar">
      {size === "l" ? <Month events={ev || []} /> : (
        <div className="date">
          <span>{d.toLocaleDateString("en-US", { weekday: "long" })}</span>
          <b>{d.getDate()}</b>
          {size === "m" && <span>{d.toLocaleDateString("en-US", { month: "long" })}</span>}
        </div>
      )}
      <div className="events">{list}</div>
    </Frame>
  );
}

export function Photos() {
  const p = usePoll("/photos", 1800000);
  const [k, setK] = useState(0);
  const [under, setUnder] = useState(null);
  const n = p?.order.length;
  useEffect(() => {
    if (!n) return;
    const id = setInterval(() => !hidden && setK((x) => x + 1), p.seconds * 1000);
    return () => clearInterval(id);
  }, [p]);
  const url = (j) => `${API}/photo/${p.order[j % n]}`;
  useEffect(() => {
    if (n) new Image().src = url(k + 1);
  }, [k, n]);
  return (
    <Frame plain className="photos">
      {under && <img className="photo" src={under} draggable={false} />}
      {n ? <img key={url(k)} className="photo fade" src={url(k)} draggable={false} onLoad={(e) => setTimeout(() => setUnder(e.target.src), 1000)} />
        : <Empty>{p === null ? "Photos unavailable" : "Add an iCloud shared album or a photo folder in Settings"}</Empty>}
    </Frame>
  );
}

const CONDITIONS = [[0, "Clear"], [1, "Mostly clear"], [2, "Partly cloudy"], [3, "Cloudy"], [48, "Fog"], [57, "Drizzle"], [67, "Rain"],
  [77, "Snow"], [82, "Showers"], [86, "Snow showers"], [99, "Thunderstorm"]];
export const condition = (c) => CONDITIONS.find(([max]) => c <= max)?.[1] ?? "";

export function WeatherIcon({ code, day = 1 }) {
  const cloud = "M7 17h9.5a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 6.3 10.5 3.3 3.3 0 0 0 7 17Z";
  const sun = <><circle cx="12" cy="12" r="4" />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1="12" y1="2.5" x2="12" y2="4.5" transform={`rotate(${a} 12 12)`} />)}</>;
  const moon = <path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5Z" />;
  const body = code <= 1 ? (day ? sun : moon)
    : code === 2 ? <><g transform="translate(-4 -4) scale(.8)">{day ? sun : moon}</g><path d={cloud} transform="translate(2 2)" /></>
    : code === 3 ? <path d={cloud} />
    : code <= 48 ? <><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="13" x2="20" y2="13" /><line x1="6" y1="17" x2="18" y2="17" /></>
    : code <= 67 || (code >= 80 && code <= 82) ? <><path d={cloud} transform="translate(0 -3)" /><line x1="9" y1="17" x2="8" y2="20" /><line x1="13" y1="17" x2="12" y2="20" /><line x1="17" y1="17" x2="16" y2="20" /></>
    : code <= 86 ? <><path d={cloud} transform="translate(0 -3)" /><circle cx="9" cy="18.5" r=".6" /><circle cx="12.5" cy="20" r=".6" /><circle cx="16" cy="18.5" r=".6" /></>
    : <><path d={cloud} transform="translate(0 -3)" /><path d="M12.5 15 10 19h3l-1.5 3.5" /></>;
  return <svg className="icon" viewBox="0 0 24 24">{body}</svg>;
}

export function Weather() {
  const size = useSize();
  const w = usePoll("/weather", 900000);
  if (!w) return <Frame className="weather"><Empty>{w === null ? "Set your city in Settings" : ""}</Empty></Frame>;
  const lo = Math.min(...w.days.map((d) => d.low)), hi = Math.max(...w.days.map((d) => d.high));
  const hours = (
    <div className="hours">
      {w.hours.slice(0, size === "s" ? 0 : 6).map((h) => <div key={h.time}><span>{h.time}</span><WeatherIcon code={h.code} day={h.day} /><b>{h.temp}°</b></div>)}
    </div>
  );
  return (
    <Frame className="weather">
      {size === "s" ? <>
        <div className="name">{w.place}</div>
        <div className="temp"><b>{w.temp}°</b></div>
        <div><WeatherIcon code={w.code} day={w.day} /><div className="sub">{condition(w.code)}</div><div className="sub">H {w.high}° L {w.low}°</div></div>
      </> : <>
        <div className="now">
          <div>
            <div className="name">{w.place}</div>
            <div className="sub">{condition(w.code)} · H {w.high}° L {w.low}°</div>
          </div>
          <div className="temp"><WeatherIcon code={w.code} day={w.day} /><b>{w.temp}°</b></div>
        </div>
        {hours}
        {size === "l" && (
          <div className="days">
            {w.days.map((d) => (
              <div key={d.date}>
                <span>{parse(d.date).toLocaleDateString("en-US", { weekday: "short" })}</span>
                <WeatherIcon code={d.code} />
                <span className="low">{d.low}°</span>
                <div className="range"><div style={{ left: ((d.low - lo) / (hi - lo || 1)) * 100 + "%", right: ((hi - d.high) / (hi - lo || 1)) * 100 + "%" }} /></div>
                <b>{d.high}°</b>
              </div>
            ))}
          </div>
        )}
      </>}
    </Frame>
  );
}

const rate = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB/s" : b >= 1024 ? Math.round(b / 1024) + " KB/s" : Math.round(b) + " B/s");

function Spark({ data, max = 100 }) {
  const top = Math.max(max, ...data, 1);
  const pts = data.map((v, i) => `${64 - ((data.length - 1 - i) / 29) * 64},${20 - (v / top) * 18}`).join(" ");
  return <svg className="spark" viewBox="0 0 64 20" preserveAspectRatio="none"><polyline points={pts} /></svg>;
}

export function System() {
  const size = useSize();
  const s = usePoll("/system", 2000);
  const hist = useRef({ cpu: [], gpu: [], ram: [], down: [] });
  useEffect(() => {
    if (!s) return;
    for (const k in hist.current) hist.current[k] = [...hist.current[k], s[k] ?? 0].slice(-30);
  }, [s]);
  const h = hist.current;
  const tiles = s && [
    ["CPU", `${Math.round(s.cpu)}%`, "", h.cpu, 100],
    ["GPU", s.gpu == null ? "n/a" : `${s.gpu}%`, s.gpu_temp == null ? "" : `${s.gpu_temp}°C`, h.gpu, 100],
    ["RAM", `${Math.round(s.ram)}%`, `${s.ram_used.toFixed(1)} of ${Math.round(s.ram_total)} GB`, h.ram, 100],
    ["Network", rate(s.down), "up " + rate(s.up), h.down, 0],
  ];
  return (
    <Frame className="system">
      {!tiles ? <Empty>{s === null ? "Logger offline" : ""}</Empty> : tiles.map(([label, value, sub, data, max]) => (
        <div className="stat" key={label}>
          <span className="label">{label}</span>
          <b>{value}</b>
          {size !== "s" && <span className="sub">{sub}</span>}
          {size !== "s" && <Spark data={data} max={max} />}
        </div>
      ))}
    </Frame>
  );
}

function Face({ d }) {
  const sec = d.getSeconds(), m = d.getMinutes() + sec / 60, h = (d.getHours() % 12) + m / 60;
  const hand = (deg, len, w, cls) => <line className={cls} x1="50" y1="50" x2="50" y2={50 - len} strokeWidth={w} transform={`rotate(${deg} 50 50)`} />;
  return (
    <svg className="face" viewBox="0 0 100 100">
      {Array.from({ length: 12 }, (_, i) => <line key={i} className="mark" x1="50" y1="5" x2="50" y2={i % 3 ? 9 : 12} transform={`rotate(${i * 30} 50 50)`} />)}
      {hand(h * 30, 24, 4.5)}
      {hand(m * 6, 36, 3)}
      {hand(sec * 6, 40, 1.2, "second")}
      <circle cx="50" cy="50" r="2.6" />
    </svg>
  );
}

export function Clock() {
  const size = useSize();
  useTick(1000);
  const d = new Date();
  return (
    <Frame className="clock">
      <Face d={d} />
      {size !== "s" && (
        <div className="digital">
          <b>{hm(d)}</b>
          <div className="sub">{d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
        </div>
      )}
    </Frame>
  );
}

const short = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function Countdown() {
  const size = useSize();
  const set = usePoll("/settings", 600000);
  useTick(60000);
  const today = new Date().setHours(0, 0, 0, 0);
  const list = (set?.countdowns || []).map((line) => {
    const [, d, title] = line.match(/^\s*(\d{4}-\d{2}-\d{2})\s*(.*)$/) || [];
    return d && { title: title.trim() || "Untitled", date: parse(d), days: Math.round((parse(d) - today) / 86400000) };
  }).filter((x) => x && x.days >= 0).sort((a, b) => a.days - b.days);
  const [first, ...rest] = list;
  if (!first) return <Frame className="calendar countdown">{set && <Empty>Add a date in Settings</Empty>}</Frame>;
  const left = (x) => (x.days === 0 ? "Today" : x.days === 1 ? "Tomorrow" : `In ${x.days} days`);
  return (
    <Frame className="calendar countdown">
      <div className="date">
        <span>{first.title}</span>
        <b className={first.days ? "" : "word"}>{first.days || "Today"}</b>
        <span>{first.days ? `${first.days === 1 ? "day" : "days"} · ${short(first.date)}` : short(first.date)}</span>
      </div>
      {size !== "s" && rest.length > 0 && (
        <div className="events">
          {rest.slice(0, size === "l" ? 5 : 3).map((x) => (
            <div className="event" key={x.title + x.days}>
              <div className="name">{x.title}</div>
              <div className="sub">{left(x)} · {short(x.date)}</div>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

const put = (body) =>
  fetch(API + "/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(() => emit("settings")).catch(() => {});

export function Todo() {
  const size = useSize();
  const set = usePoll("/settings", 600000);
  const [mine, setMine] = useState(null);
  useEffect(() => setMine(null), [set]);
  const list = mine || set?.todos || [];
  const tick = (i) => {
    const next = list.map((t, k) => (k === i ? { ...t, done: !t.done } : t));
    setMine(next);
    put({ todos: next });
  };
  const left = list.filter((t) => !t.done).length;
  const shown = list.map((t, i) => [t, i]).sort((a, b) => a[0].done - b[0].done).slice(0, size === "l" ? 10 : 4);
  return (
    <Frame className="todo">
      <div className="head-line"><span>To do</span><span>{left ? `${left} left` : list.length ? "All done" : ""}</span></div>
      {set && !list.length ? <Empty>Add tasks in Settings</Empty> : shown.map(([t, i]) => (
        <button key={i} className={"task" + (t.done ? " done" : "")} onPointerUp={(e) => (e.stopPropagation(), tick(i))}><i />{t.text}</button>
      ))}
    </Frame>
  );
}

function useStored(key, init) {
  const [v, setV] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? init;
    } catch {
      return init;
    }
  });
  useEffect(() => {
    const f = (e) => {
      if (e.key !== key) return;
      try {
        setV(JSON.parse(e.newValue) ?? init);
      } catch {}
    };
    addEventListener("storage", f);
    return () => removeEventListener("storage", f);
  }, [key]);
  const save = (x) => {
    setV(x);
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {}
  };
  return [v, save];
}

export function Timer() {
  const size = useSize();
  const set = usePoll("/settings", 600000);
  const [focus, rest] = (set?.pomodoro || [25, 5]).map((m) => m * 60000);
  const [t, setT] = useStored("timer", { mode: "focus", left: null, end: null, done: 0, day: "" });
  useTick(1000);
  const len = t.mode === "focus" ? focus : rest;
  const raw = t.end ? t.end - Date.now() : t.left ?? len;
  const day = new Date().toDateString();
  useEffect(() => {
    if (t.end && raw <= 0) {
      const f = t.mode === "focus";
      setT({ mode: f ? "break" : "focus", left: null, end: null, done: f ? (t.day === day ? t.done : 0) + 1 : t.done, day: f ? day : t.day });
    }
  });
  const left = Math.max(0, Math.min(raw, len));
  const secs = Math.ceil(left / 1000);
  const toggle = () => setT(t.end ? { ...t, end: null, left } : { ...t, end: Date.now() + left, left: null });
  const reset = (e) => {
    e.stopPropagation();
    setT(t.end || t.left != null ? { ...t, end: null, left: null } : { ...t, mode: t.mode === "focus" ? "break" : "focus" });
  };
  const today = t.day === day ? t.done : 0;
  return (
    <Frame className={"timer " + t.mode + (t.end ? " running" : "")} onClick={toggle}>
      <div className="ring">
        <svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="44" />
          <circle cx="50" cy="50" r="44" className="done" strokeDasharray={276.5} strokeDashoffset={276.5 * (left / len)} />
        </svg>
        <b>{Math.floor(secs / 60)}:{pad(secs % 60)}</b>
      </div>
      {size !== "s" && (
        <div className="info">
          <div className="title">{t.mode === "focus" ? "Focus" : "Break"}</div>
          <div className="sub">{today ? `${today} ${today === 1 ? "session" : "sessions"} today` : "No sessions yet today"}</div>
          <div className="sub">{t.end ? "Click to pause" : "Click to start"}</div>
          <button className="pill" onPointerUp={reset}>{t.end || t.left != null ? "Reset" : `Skip to ${t.mode === "focus" ? "break" : "focus"}`}</button>
        </div>
      )}
    </Frame>
  );
}

export function Note() {
  const set = usePoll("/settings", 600000);
  const text = set?.note?.trim();
  return (
    <Frame className="note">
      {set && (text ? <p style={{ fontSize: text.length < 40 ? 20 : text.length < 120 ? 15 : 13 }}>{text}</p> : <Empty>Write a note in Settings</Empty>)}
    </Frame>
  );
}

export const signed = (n) => (n > 0 ? "+" + n : String(n ?? 0));
export const result = (m) => (m.won == null ? "D" : m.won ? "W" : "L");
export const score = (m) => (m.rounds_lost == null ? `${m.rounds_won ?? 0} rounds` : `${m.rounds_won ?? 0}-${m.rounds_lost}`);

export function Valorant() {
  const size = useSize();
  const v = usePoll("/valorant", 120000);
  if (!v?.enabled) return <Frame className="valorant">{v && <Empty>Turn on the Valorant tracker in Settings</Empty>}</Frame>;
  const tier = v.assets.tiers[v.current?.tier] || {};
  const change = v.current?.last_change ?? 0;
  return (
    <Frame className="valorant">
      <div className="vrank">
        {tier.icon ? <img src={tier.icon} draggable={false} /> : <div className="noicon" />}
        <div className="info">
          <div className="title">{tier.name || "Unranked"}</div>
          <div className="sub">{v.current?.rr ?? 0} RR <span className={change >= 0 ? "up" : "down"}>{signed(change)}</span></div>
          {size !== "s" && <div className="bar"><div style={{ width: Math.min(100, v.current?.rr ?? 0) + "%" }} /></div>}
          {size !== "s" && <div className="vresults">{v.matches.slice(0, 5).map((m) => <i key={m.id} className={result(m)}>{result(m)}</i>)}</div>}
        </div>
      </div>
      {size === "l" && (
        <div className="vrows">
          {v.matches.slice(0, 4).map((m) => (
            <div key={m.id} className={"vrow " + result(m)}>
              {v.assets.agents[m.agent_id]?.icon && <img src={v.assets.agents[m.agent_id].icon} draggable={false} />}
              <div className="info"><div className="name">{m.map}</div><div className="sub">{m.mode}</div></div>
              <b>{score(m)}</b>
              <span>{m.kills}/{m.deaths}/{m.assists}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

const HOW = { Eliminated: "elimination", "Bomb detonated": "spike", "Bomb defused": "defuse", "Round timer expired": "time" };

// Round timeline: one slim bar per round, green won / red lost, taller = more kills, faded = died,
// yellow dot = first blood, a gap at halftime (after round 4 in short modes, 12 otherwise) and before overtime.
export function Rounds({ list }) {
  const half = list.length <= 9 ? 3 : 11;
  return (
    <div className="rtl">
      {list.map((r, i) => (
        <i key={i} style={{ "--k": Math.min(r.k || 0, 5) }}
          className={(r.won == null ? "N" : r.won ? "W" : "L") + (r.died ? " died" : "") + (i === half || i === 23 ? " half" : "")}
          title={`Round ${i + 1}: ${r.won == null ? "no team winner" : `${r.won ? "won" : "lost"} by ${HOW[r.how] || r.how || "?"}`} · ${r.k} ${r.k === 1 ? "kill" : "kills"} · ${r.dmg} damage${r.fb ? " · first blood" : ""}${r.fd ? " · died first" : ""}${r.plant ? " · planted" : ""}${r.defuse ? " · defused" : ""} · $${r.loadout.toLocaleString("en-US")} loadout`}>
          {r.fb && <s />}
        </i>
      ))}
    </div>
  );
}

const winPct = (t) => (t?.decided ? Math.round((t.wins / t.decided) * 100) : 0);

function Record({ label, t }) {
  return (
    <div className="tp-rec">
      <span className="tp-k">{label}</span>
      {t?.games ? <>
        <b>{t.wins}-{t.decided - t.wins}</b>
        <div className="tp-meter"><div style={{ width: winPct(t) + "%" }} /></div>
        <span>{winPct(t)}% · {t.kd.toFixed(2)} K/D</span>
      </> : <span className="tp-none">First time</span>}
    </div>
  );
}

export function TabPanel() {
  const v = usePoll("/valorant/live", 20000);
  const now = usePoll("/now", 10000);
  if (!v?.enabled) return null;
  const a = v.assets, lv = v.live, tier = a.tiers[v.current?.tier] || {};
  const agent = lv?.agent_id && a.agents[lv.agent_id];
  const change = v.current?.last_change ?? 0, last = v.last;
  return (
    <div className="tp">
      <div className="tp-top">
        <span className="tp-k">{lv ? [lv.mode, lv.map, agent?.name].filter(Boolean).join(" · ") : "Valorant"}</span>
        {now?.id && <span className="tp-song"><i className={now.playing ? "eq on" : "eq"}><s /><s /><s /></i>{now.name} · {now.artists}</span>}
      </div>
      <div className="tp-main">
        <div className="tp-rank">
          {tier.icon && <img src={tier.icon} />}
          <div className="tp-grow">
            <div className="tp-row"><b>{tier.name || "Unranked"}</b><i className={change >= 0 ? "up" : "down"}>{signed(change)}</i></div>
            <div className="tp-bar"><div style={{ width: Math.min(100, v.current?.rr ?? 0) + "%" }} /></div>
            <span className="tp-k">{v.current?.rr ?? 0} / 100 RR</span>
          </div>
        </div>
        <div className="tp-tiles">
          <div><b>{v.today.wins}-{v.today.decided - v.today.wins}</b><span>Today</span></div>
          <div><b className={v.today.rr > 0 ? "up" : v.today.rr < 0 ? "down" : ""}>{signed(v.today.rr)}</b><span>RR today</span></div>
          <div><b>{v.today.games ? v.today.kd.toFixed(2) : "-"}</b><span>K/D today</span></div>
        </div>
        {lv?.map && (
          <div className="tp-recs">
            <Record label={lv.map} t={v.map} />
            {agent && <Record label={agent.name} t={v.agent} />}
          </div>
        )}
        {last && (
          <div className="tp-last">
            <div className="tp-row">
              <span className="tp-k">Last · {last.map} · {last.kills}/{last.deaths}/{last.assists}</span>
              <span className={"tp-res " + result(last)}>{result(last) === "W" ? "Win" : result(last) === "L" ? "Loss" : "Draw"} {score(last)}</span>
            </div>
            <Rounds list={last.round_list} />
          </div>
        )}
      </div>
    </div>
  );
}
