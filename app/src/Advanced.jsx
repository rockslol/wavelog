import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { API, get } from "./api";
import { REPO } from "./meta";
import { checkForUpdate, installUpdate, useUpdate } from "./update";
import { Row, Segmented, Switch } from "./Stats";

const JOBS = {
  "poller.poll_current": "Now playing", "poller.poll_recent": "Recently played", "poller.fill_missing": "Song details",
  "db.backup": "Daily backup", "games.track": "Game tracking", "lastfm.auto": "Last.fm sync", "valorant.sync": "Valorant matches",
};
const ago = (t) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
const fmt = (n) => (n ?? 0).toLocaleString("en-US");
const post = (path, body) =>
  fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/;

// Log lines grouped into entries, so a traceback stays with the error it belongs to.
function entries(lines) {
  const out = [];
  for (const l of lines) {
    if (STAMP.test(l) || !out.length) out.push({ text: l, level: / (ERROR|CRITICAL) /.test(l) ? "error" : / WARNING /.test(l) ? "warn" : / DEBUG /.test(l) ? "debug" : "info" });
    else out[out.length - 1].text += "\n" + l;
  }
  return out;
}

export function Advanced() {
  const [info, setInfo] = useState(null);
  const [down, setDown] = useState(false);
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState("all");
  const [msg, setMsg] = useState({});
  const [app, setApp] = useState(null);
  const box = useRef(null), stick = useRef(true);
  const say = (k, text) => setMsg((m) => ({ ...m, [k]: text }));
  const load = () => get("/debug/info").then((j) => (setInfo(j), setDown(false))).catch(() => setDown(true));

  useEffect(() => {
    let stop = false;
    const tick = () => {
      if (stop || document.hidden) return;
      load();
      get("/debug/log?lines=400").then((j) => !stop && setLines(j.lines)).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 2000);
    getVersion().then(setApp).catch(() => {});
    return () => ((stop = true), clearInterval(id));
  }, []);
  const shown = entries(lines).filter((e) => filter === "all" || (filter === "warn" ? e.level !== "info" && e.level !== "debug" : e.level === "error"));
  useEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [lines, filter]);

  const restart = async () => {
    say("logger", "Restarting");
    await post("/debug/shutdown").catch(() => {});
    const ok = await invoke("start_logger").catch(() => false);
    say("logger", ok ? "Restarted" : "Couldn't start it again. Quit the app from the tray and open it");
    load();
  };
  const backup = () => post("/debug/backup").then((j) => say("backup", j)).catch(() => say("backup", { error: true }));
  const clear = () => post("/debug/clear-cache").then((j) => say("cache", `Cleared. ${j.photos} cached photos will download again`)).catch(() => {});
  const level = (on) => post("/debug/loglevel", { level: on ? "DEBUG" : "INFO" }).then(load).catch(() => {});
  const copy = (text, k) => navigator.clipboard.writeText(text).then(() => say(k, "Copied")).catch(() => say(k, "Couldn't copy"));
  const diagnostics = () => {
    const home = (info?.data_dir || "").replace(/\\AppData\\.*$/, "");
    const clean = (s) => (home ? String(s).split(home).join("~") : s);
    const d = { app: app, build: __BUILD__, webview: navigator.userAgent.match(/(Edg|Chrome)\/[\d.]+/g)?.join(" "), ...info, data_dir: clean(info?.data_dir), log_file: clean(info?.log_file),
      recent_errors: entries(lines).filter((e) => e.level === "error").slice(-5).map((e) => clean(e.text)) };
    copy(JSON.stringify(d, null, 2), "diag");
  };

  if (down && !info) return (
    <section className="card group">
      <Row label="Logger" hint="Not answering on 127.0.0.1:8721">
        <button className="pill glass" onClick={restart}>{msg.logger || "Start it"}</button>
      </Row>
    </section>
  );
  if (!info) return <p className="hint foot-note">Loading</p>;
  const db = info.db, jobs = Object.entries(info.jobs);
  return (
    <>
      <h4>Status</h4>
      <section className="card group">
        <Row label={<span className="dot-label"><i className={down ? "bad" : "ok"} />Logger</span>}
          hint={msg.logger || `Version ${info.version} · running ${ago(info.started).replace(" ago", "")} · port ${info.port}${info.frozen ? "" : " · developer mode"}`}>
          <button className="pill glass" onClick={restart}>Restart</button>
        </Row>
        <Row label={<span className="dot-label"><i className={info.spotify.signed_in ? "ok" : "bad"} />Spotify</span>}
          hint={!info.spotify.client_id ? "No Client ID yet. Add it in General" : info.spotify.signed_in ? "Signed in" : "Not signed in"}>
          <button className="pill glass" onClick={() => invoke("open_url", { url: "http://127.0.0.1:8721/login" })}>{info.spotify.signed_in ? "Sign in again" : "Sign in"}</button>
        </Row>
        <Row label="Database" hint={`${fmt(db.plays)} plays · ${fmt(db.tracks)} songs · ${fmt(db.artists)} artists · ${size(db.size)}${db.first ? ` · since ${db.first.slice(0, 10)}` : ""}${db.missing ? ` · ${fmt(db.missing)} songs waiting for details` : ""}`}>
          <button className="pill glass" onClick={backup}>Back up now</button>
        </Row>
        {msg.backup && (
          <Row label="" hint={msg.backup.error ? "Backup failed, see the log" : `Saved ${size(msg.backup.size)} to the backups folder`}>
            {!msg.backup.error && <button className="link" onClick={() => invoke("reveal", { path: msg.backup.path })}>Show in folder</button>}
          </Row>
        )}
        <Row label="Plays by source" hint={Object.entries(db.sources).map(([k, n]) => `${k} ${fmt(n)}`).join(" · ")} />
        <Row label="Data folder" hint={info.data_dir}>
          <button className="pill glass" onClick={() => invoke("reveal", { path: info.data_dir })}>Open</button>
        </Row>
      </section>

      <h4>Background jobs</h4>
      <section className="card group">
        {jobs.length ? jobs.map(([k, j]) => (
          <Row key={k} label={<span className="dot-label"><i className={j.error ? "bad" : j.last_ok ? "ok" : "idle"} />{JOBS[k] || k}</span>}
            hint={j.error ? j.error : `Last ran ${ago(j.last_run)} · ${fmt(j.runs)} ${j.runs === 1 ? "run" : "runs"}${j.fails ? ` · ${fmt(j.fails)} failed` : ""}`}>
            <span className="hint">{j.error ? `Last worked ${ago(j.last_ok)}` : ""}</span>
          </Row>
        )) : <Row label="No jobs yet" hint="They start a few seconds after the logger" />}
      </section>

      <h4>Log</h4>
      <section className="card logcard">
        <div className="log-tools">
          <Segmented options={[["all", "All"], ["warn", "Warnings"], ["error", "Errors"]]} value={filter} onChange={setFilter} />
          <span className="hint">{msg.log}</span>
          <button className="link" onClick={() => copy(shown.map((e) => e.text).join("\n"), "log")}>Copy</button>
          <button className="link" onClick={() => invoke("reveal", { path: info.log_file })}>Open file</button>
        </div>
        <div className="logview" ref={box} onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 30)}>
          {shown.length ? shown.map((e, i) => <pre key={i} className={e.level}>{e.text}</pre>) : <p className="hint">Nothing here</p>}
        </div>
      </section>

      <h4>Developer</h4>
      <section className="card group">
        <Row label="Developer tools" hint="Inspect this window, like F12 in a browser">
          <button className="pill glass" onClick={() => invoke("devtools")}>Open</button>
        </Row>
        <Row label="Detailed logging" hint="Writes more to the log, until the logger restarts">
          <Switch on={info.log_level === "DEBUG"} onChange={() => level(info.log_level !== "DEBUG")} />
        </Row>
        <Row label="Clear caches" hint={msg.cache || "Album colours, photos and weather load again. Your plays stay"}>
          <button className="pill glass" onClick={clear}>Clear</button>
        </Row>
        <Row label="Copy diagnostics" hint={msg.diag || "Versions, counts, job status and recent errors, for bug reports. Your username is removed"}>
          <button className="pill glass" onClick={diagnostics}>Copy</button>
        </Row>
      </section>
    </>
  );
}

export function About() {
  const [v, setV] = useState(null);
  const up = useUpdate();
  const upHint = up.state === "checking" ? "Checking"
    : up.state === "available" ? `Version ${up.update.version} is out${up.update.body ? ": " + up.update.body.split("\n")[0] : ""}`
    : up.state === "installing" ? `Downloading ${Math.round(up.progress * 100)}%, Wavelog restarts when done`
    : up.state === "error" ? `Couldn't check: ${up.error}`
    : up.state === "latest" ? "You're on the latest version"
    : "Checks automatically every few hours";
  useEffect(() => {
    getVersion().then(setV).catch(() => {});
  }, []);
  const built = new Date(__BUILD__).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return (
    <>
      <section className="card about">
        <span className="logo"><i /><i /><i /></span>
        <div>
          <h2>Wavelog</h2>
          <div className="sub">Version {v || "dev"} · built {built}</div>
          <p className="hint">Your Spotify listening, recorded and kept on this PC, with desktop widgets, a notch and stats. No account, no server, nothing leaves your computer except the calls to Spotify and the services you turn on.</p>
        </div>
      </section>
      <section className="card group">
        <Row label="Updates" hint={upHint}>
          {up.state === "available" || up.state === "installing"
            ? <button className="pill glass" onClick={installUpdate} disabled={up.state === "installing"}>Update to {up.update.version}</button>
            : <button className="pill glass" onClick={checkForUpdate} disabled={up.state === "checking"}>Check now</button>}
        </Row>
      </section>
      <h4>Project</h4>
      <section className="card group">
        {REPO && (
          <Row label="Source code" hint={REPO.replace("https://", "")}>
            <button className="pill glass" onClick={() => invoke("open_url", { url: REPO })}>GitHub</button>
          </Row>
        )}
        {REPO && (
          <Row label="Report a problem" hint="Open an issue and paste Copy diagnostics from Advanced">
            <button className="pill glass" onClick={() => invoke("open_url", { url: REPO + "/issues" })}>Issues</button>
          </Row>
        )}
        <Row label="License" hint="MIT: free to use, change and share"><span className="hint">MIT</span></Row>
      </section>
      <h4>Built with</h4>
      <section className="card group">
        <Row label="App" hint="Tauri, React, Vite, Inter font" />
        <Row label="Logger" hint="Python, FastAPI, SQLite, Pillow, psutil" />
        <Row label="Data from" hint="Spotify Web API, LRCLIB and NetEase lyrics, Open-Meteo weather, Last.fm, the Riot Client on this PC" />
      </section>
      <p className="hint foot-note">Not affiliated with or endorsed by Spotify, Riot Games or Last.fm. Valorant stats come from unofficial Riot Client endpoints and can break after a game update.</p>
    </>
  );
}
