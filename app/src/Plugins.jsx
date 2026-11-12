// Plugins: the block renderer (what plugin pages, widgets and notch sections are drawn with) and Settings > Plugins.
// Plugins never run code in this window: they send blocks (see backend/wavelog.py) and this draws them.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { API, get, usePoll, useSize } from "./api";
import Columns from "./Columns";
import Frame from "./Frame";
import { Row, Segmented, Switch } from "./Stats";

export const pimg = (src) => (src && src.startsWith("/") ? API + src : src);

export const send = (path, method = "POST", body) =>
  fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.detail ? (typeof j.detail === "string" ? j.detail : "Not accepted") : "Couldn't reach the logger");
      return j;
    });

// The installed plugins, shared by the sidebar and Settings so both update together.
let list = null;
const subs = new Set();
export const loadPlugins = () => get("/plugins").then((j) => ((list = j), subs.forEach((f) => f(j)), j));
export const pluginList = () => list;
export const running = (d) => (d?.plugins || []).filter((p) => p.enabled && !p.error);

// Window labels: p_<plugin>_<widget> and po_<plugin>_<overlay>; notch sections use the same p_<plugin>_<section>.
// Plugin ids have no underscores, so the first one after the prefix splits them.
export const slot = (pid, id) => `p_${pid}_${id}`;
export const unslot = (label, prefix = "p_") => {
  const rest = label.slice(prefix.length), i = rest.indexOf("_");
  return [rest.slice(0, i), rest.slice(i + 1)];
};
// What the plugins add to each place: [slot id, title, plugin, item].
export const pluginWidgets = (d) => running(d).flatMap((p) => p.widgets.map((w) => [slot(p.id, w.id), w.title, p, w]));
export const pluginSections = (d) => running(d).flatMap((p) => p.sections.map((s) => [slot(p.id, s.id), s.title, p, s]));
export const pluginOverlays = (d) => running(d).flatMap((p) => p.overlays.map((o) => [`po_${p.id}_${o.id}`, o.game, o.key, o.w, o.h, o.y ?? 0.7]));
export function usePlugins() {
  const [d, setD] = useState(list);
  useEffect(() => {
    subs.add(setD);
    let retry;
    const load = () => loadPlugins().catch(() => (retry = setTimeout(load, 5000)));
    load();
    const id = setInterval(() => !document.hidden && loadPlugins().catch(() => {}), 30000);
    return () => (subs.delete(setD), clearInterval(id), clearTimeout(retry));
  }, []);
  return d;
}

const Pic = ({ src, round, big, className = "" }) =>
  src ? <img className={`img${round ? " round" : ""}${big ? " big" : ""} ${className}`} src={pimg(src)} draggable={false} loading="lazy" decoding="async" />
    : <div className={`img${round ? " round" : ""}${big ? " big" : ""} ${className}`} />;

const Head = ({ title, hint, children }) => (title || hint || children) && (
  <div className="head">{title && <h3>{title}</h3>}{hint && <span className="hint">{hint}</span>}{children}</div>
);

const word = (v) => typeof v === "string" && !/\d/.test(v);

function Search({ b, run }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    let live = true;
    const id = setTimeout(() => run(b.action, { q: q.trim() }, true).then((r) => live && setHits(Array.isArray(r) ? r : [])), 220);
    return () => ((live = false), clearTimeout(id));
  }, [q]);
  return (
    <section className="card">
      <Head title={b.title} hint={b.hint} />
      <input className="vsearch" value={q} onChange={(e) => setQ(e.target.value)} placeholder={b.placeholder} spellCheck={false} />
      {hits.length > 0 && (
        <div className="vhits">
          {hits.map((h, i) => (
            <button key={i} onClick={() => h.action && run(h.action, h.args).then(() => setQ(""))}>
              {h.image ? <img src={pimg(h.image)} draggable={false} /> : <i />}
              <span>{h.title}{h.sub && <small> · {h.sub}</small>}</span>{h.right && <b>{h.right}</b>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

const Chips = ({ items, run }) => (
  <div className="pb-chips">
    {items.map((c, i) => (
      <span key={i} className={"pb-chip" + (c.action ? " clickable" : "")} style={c.color ? { "--c": c.color } : undefined}
        onClick={c.action ? () => run(c.action, c.args) : undefined}>{c.text}</span>
    ))}
  </div>
);

// A timeline of slim bars (e.g. a match's rounds): green good, red bad, taller = higher level, faded, yellow dot.
const Strip = ({ segs }) => (
  <div className="rtl">
    {segs.map((g, i) => (
      <i key={i} style={{ "--k": Math.min(Math.max(g.level ?? 1, 0), 5) }} title={g.tip}
        className={(g.tone === "good" ? "W" : g.tone === "bad" ? "L" : "N") + (g.faded ? " died" : "") + (g.gap ? " half" : "")}>
        {g.dot && <s />}
      </i>
    ))}
  </div>
);

function Block({ b, run, compact }) {
  switch (b.type) {
    case "header":
      return (
        <section className="card spotlight pb-header">
          {b.image && <Pic src={b.image} big round={b.round} />}
          <div className="grow">
            <h2>{b.title}</h2>
            {b.sub && <div className="sub">{b.sub}</div>}
            {b.chips && <Chips items={b.chips} run={run} />}
            {b.bar != null && <div className="bar rr"><div style={{ width: Math.min(100, Math.max(0, b.bar * 100)) + "%" }} /></div>}
            {b.note && <div className="hint">{b.note}</div>}
          </div>
        </section>
      );
    case "hero":
      return (
        <section className="card wrapped-hero">
          {b.label && <div className="sub">{b.label}</div>}
          <h2>{b.title}</h2>
          {b.text && <p className="hint">{b.text}</p>}
          {b.button && b.action && <button className="primary" onClick={() => run(b.action, b.args)}>{b.button}</button>}
        </section>
      );
    case "tiles":
      return (
        <div className={"tiles" + (compact ? " pb-tiles-s" : "")}>
          {b.items.map((t, i) => (
            <div key={i} className="card tile">
              <div className="label">{t.label}</div>
              <div className={"value" + (word(t.value) ? " word" : "")} title={typeof t.value === "string" ? t.value : undefined}>
                {typeof t.value === "number" ? t.value.toLocaleString("en-US") : t.value}
              </div>
              {t.sub && <div className="sub">{t.sub}</div>}
            </div>
          ))}
        </div>
      );
    case "bars":
      return <Columns title={b.title} unit={b.unit} data={b.data.map((d) => ({ value: +d.value || 0, label: d.label, tick: d.label }))} />;
    case "list":
      return (
        <section className="card">
          <Head title={b.title} hint={b.hint} />
          {b.items.length ? (
            <ol className="list">
              {b.items.map((x, i) => (
                <li key={i} className={x.action ? "clickable" : ""} onClick={x.action ? () => run(x.action, x.args) : undefined}>
                  {b.ranked && <span className="rank">{i + 1}</span>}
                  {x.image && <Pic src={x.image} round={x.round} />}
                  <div className="meta">
                    <div className="name">{x.title}</div>
                    {x.sub && <div className="sub">{x.sub}</div>}
                    {x.chips && <Chips items={x.chips} run={run} />}
                    {x.strip?.length > 0 && <Strip segs={x.strip} />}
                    {x.meter != null && <div className="meter"><div style={{ width: Math.min(100, x.meter * 100) + "%" }} /></div>}
                  </div>
                  {x.right != null && <span className={"mv pb-right" + (x.mood ? " " + x.mood : "")}>{x.right}</span>}
                </li>
              ))}
            </ol>
          ) : <p className="none">{b.empty || "Nothing here yet."}</p>}
        </section>
      );
    case "grid":
      return (
        <section className="card">
          <Head title={b.title} hint={b.hint} />
          {b.items.length ? (
            <div className="pb-grid" style={{ "--cols": b.columns || 4 }}>
              {b.items.map((c, i) => (
                <div key={i} className={"pb-card" + (c.on ? " on" : "") + (c.action && c.on == null ? " clickable" : "")} style={c.color ? { "--tint": c.color } : undefined}
                  onClick={c.action && c.on == null ? () => run(c.action, c.args) : undefined}>
                  {c.on != null && c.action && (
                    <button className="vheart" title={c.on ? "Remove" : "Keep"} onClick={() => run(c.action, c.args)}>{c.on ? "♥" : "♡"}</button>
                  )}
                  {c.badge && <em className="pb-badge">{c.badge}</em>}
                  {c.image ? <img src={pimg(c.image)} draggable={false} loading="lazy" /> : <div className="pb-noimg" />}
                  <div className="vname" title={c.title}>{c.title}</div>
                  {c.sub && <div className="pb-sub">{c.sub}</div>}
                </div>
              ))}
            </div>
          ) : <p className="none">{b.empty || "Nothing here yet."}</p>}
        </section>
      );
    case "chips":
      return b.title ? <section className="card"><Head title={b.title} /><Chips items={b.items} run={run} /></section> : <Chips items={b.items} run={run} />;
    case "text":
      return <p className={"pb-text" + (b.muted ? " hint" : "")}>{b.text}</p>;
    case "buttons":
      return (
        <div className="pb-buttons">
          {b.items.map((x, i) => <button key={i} className={x.primary ? "primary" : "pill glass"} onClick={() => run(x.action, x.args)}>{x.label}</button>)}
        </div>
      );
    case "search":
      return <Search b={b} run={run} />;
    case "columns":
      return <div className={b.items.length > 2 ? "grid3" : "grid2"}>{b.items.map((x, i) => <Block key={i} b={x} run={run} compact={compact} />)}</div>;
    case "error":
      return <section className="card pb-error"><b>The plugin hit an error</b><span className="hint">{b.text}</span></section>;
    default:
      return null;
  }
}

// Draws a plugin's blocks. Buttons, cards and search boxes call the plugin's actions, then the view reloads.
export function Blocks({ pid, blocks, reload, compact }) {
  const [err, setErr] = useState(null);
  const run = (action, args, quiet) => send(`/p/${pid}/action/${encodeURIComponent(action)}`, "POST", args || {})
    .then((r) => (quiet || reload?.(), setErr(null), r))
    .catch((e) => (setErr(e.message), null));
  return (
    <>
      {err && <p className="pb-error-line">{err}</p>}
      {(Array.isArray(blocks) ? blocks : []).map((b, i) => <Block key={i} b={b} run={run} compact={compact} />)}
    </>
  );
}

// A plugin widget on the desktop (window p_<plugin>_<widget>).
export function PluginWidget() {
  const [pid, name] = unslot(getCurrentWindow().label);
  const size = useSize();
  const [n, setN] = useState(0);
  const blocks = usePoll(`/p/${pid}/widget/${name}?size=${size}&r=${n}`, 30000);
  return (
    <Frame className="pwidget">
      {blocks === undefined ? null : blocks === null ? (
        <div className="pw-off"><b>Plugin widget</b><span>Its plugin is off or removed. Turn it on in Settings → Plugins</span></div>
      ) : <Blocks pid={pid} blocks={blocks} reload={() => setN((x) => x + 1)} compact />}
    </Frame>
  );
}

// A plugin panel over a game while its key is held (window po_<plugin>_<overlay>). Read each time it opens.
export function PluginOverlay() {
  const [pid, name] = unslot(getCurrentWindow().label, "po_");
  const [blocks, setBlocks] = useState(null);
  useEffect(() => {
    document.documentElement.classList.add("overlay");
    const off = listen("visibility", (e) => e.payload && get(`/p/${pid}/overlay/${name}`).then(setBlocks).catch(() => {}));
    get(`/p/${pid}/overlay/${name}`).then(setBlocks).catch(() => {});
    return () => void off.then((f) => f());
  }, []);
  return blocks && <div className="tp po"><Blocks pid={pid} blocks={blocks} compact /></div>;
}

// A plugin section in the notch's dashboard. Read when the notch opens, and every 15 s while it's open.
export function PluginSection({ pid, id, open }) {
  const [blocks, setBlocks] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => get(`/p/${pid}/notch/${id}`).then((b) => live && setBlocks(b)).catch(() => live && setBlocks(null));
    load();
    const t = setInterval(load, 15000);
    return () => ((live = false), clearInterval(t));
  }, [open, n]);
  return blocks?.length > 0 && <div className="n-plugin" onClick={(e) => e.stopPropagation()}><Blocks pid={pid} blocks={blocks} reload={() => setN((x) => x + 1)} compact /></div>;
}

// --- Settings > Plugins ------------------------------------------------------------------------------------------
function SettingField({ spec, value, save }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const t = spec.type;
  const ctl = t === "switch" ? <Switch on={!!value} onChange={() => save(!value)} />
    : t === "choice" ? <Segmented options={(spec.options || []).map((o) => (Array.isArray(o) ? o : [o, String(o)]))} value={value} onChange={save} />
    : t === "slider" ? (
      <input type="range" min={spec.min ?? 0} max={spec.max ?? 1} step={spec.step ?? (((spec.max ?? 1) - (spec.min ?? 0)) / 100)} value={v ?? 0}
        onChange={(e) => setV(+e.target.value)} onPointerUp={() => save(v)} onKeyUp={() => save(v)} />
    ) : null;
  if (ctl) return <Row label={spec.label || spec.key} hint={spec.hint}>{ctl}</Row>;
  return (
    <label className="field">
      <span>{spec.label || spec.key}{spec.hint ? ` · ${spec.hint}` : ""}</span>
      <input type={t === "number" ? "number" : spec.secret ? "password" : "text"} value={v ?? ""} placeholder={spec.placeholder || ""}
        min={spec.min} max={spec.max} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && save(t === "number" ? +v : v)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} spellCheck={false} />
    </label>
  );
}

function PluginCard({ p, setTab, update, onUpdate }) {
  const [msg, setMsg] = useState(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const doUpdate = () => {
    setBusy(true);
    setMsg(null);
    onUpdate(p.id).then(() => setMsg(`Updated to v${update}`), (e) => setMsg(e.message)).finally(() => setBusy(false));
  };
  const act = (path, method, body, done) => send(path, method, body).then((r) => (setMsg(done || null), loadPlugins(), r)).catch((e) => setMsg(e.message));
  useEffect(() => {
    if (!sure) return;
    const id = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(id);
  }, [sure]);
  const by = [p.version && "v" + p.version, p.author && "by " + p.author].filter(Boolean).join(" · ");
  return (
    <section className={"card group pl-card" + (p.enabled ? "" : " off")}>
      <Row label={
        <span className="pl-name">
          {p.icon ? <img src={pimg(p.icon)} draggable={false} /> : <i className="pl-noicon" />}
          {p.name}{p.dev && <em className="pl-badge">Developer</em>}
        </span>
      } hint={p.error ? null : [p.description, by].filter(Boolean).join(" · ")}>
        <Switch on={p.enabled && !p.error} onChange={() => act(`/plugins/${p.id}`, "PUT", { enabled: !p.enabled })} />
      </Row>
      {p.error && <p className="pl-error">Couldn't start: {p.error}</p>}
      {!p.error && p.last_error && <p className="pl-error soft">Last error: {p.last_error}</p>}
      {p.enabled && !p.error && p.settings.map((spec) => (
        <SettingField key={spec.key} spec={spec} value={p.values[spec.key]}
          save={(v) => act(`/plugins/${p.id}`, "PUT", { values: { [spec.key]: v } }, "Saved")} />
      ))}
      <div className="pl-foot">
        {p.uses.length > 0 && <span className="hint">{p.uses.join(" · ")}</span>}
        <span className="grow" />
        {msg && <span className="hint">{msg}</span>}
        {update && <button className="pill glass" disabled={busy} onClick={doUpdate}>{busy ? "Updating…" : `Update to v${update}`}</button>}
        {p.enabled && !p.error && p.pages.map((pg) => (
          <button key={pg.id} className="link" onClick={() => setTab(`p.${p.id}.${pg.id}`)}>Open {pg.title}</button>
        ))}
        {p.dev && <button className="link" onClick={() => act(`/plugins/${p.id}/reload`, "POST", undefined, "Reloaded")}>Reload</button>}
        <button className="link" onClick={() => invoke("reveal", { path: p.path + "\\plugin.json" })}>Show files</button>
        <button className={"link" + (sure ? " danger" : "")} onClick={() => (sure ? act(`/plugins/${p.id}`, "DELETE") : setSure(true))}>
          {sure ? "Click again to remove" : p.dev ? "Unlink" : "Remove"}
        </button>
      </div>
    </section>
  );
}

// One plugin from the registry, in Settings > Plugins > Get plugins.
function BrowseRow({ e, pick }) {
  const by = [e.author && "by " + e.author, e.version && "v" + e.version].filter(Boolean).join(" · ");
  const right = e.dev ? <span className="hint">Loaded from a folder</span>
    : e.blocked ? <span className="hint">{e.blocked}</span>
    : e.update ? <button className="pill glass" onClick={pick}>Update</button>
    : e.installed ? <span className="hint">Installed</span>
    : <button className="pill glass" onClick={pick}>Install</button>;
  return (
    <Row label={
      <span className="pl-name">
        {e.icon ? <img src={pimg(e.icon)} draggable={false} /> : <i className="pl-noicon" />}
        {e.name}{e.official && <em className="pl-badge official">Official</em>}
      </span>
    } hint={[e.description, by].filter(Boolean).join(" · ")}>{right}</Row>
  );
}

export function PluginSettings({ setTab }) {
  const d = usePlugins();
  const [path, setPath] = useState("");
  const [devPath, setDevPath] = useState("");
  const [preview, setPreview] = useState(null); // {path, info} from a file or {id, info} from Browse, waiting for "Install"
  const [msg, setMsg] = useState(null);
  const [over, setOver] = useState(false);
  const [reg, setReg] = useState(null); // the registry: {plugins, error}
  const [busy, setBusy] = useState(false);
  const loadReg = (fresh) => send(`/plugins/registry${fresh ? "?fresh=true" : ""}`, "GET")
    .then(setReg).catch((e) => setReg({ plugins: [], error: e.message }));
  useEffect(() => void loadReg(false), []);
  const inspect = (p) => {
    setMsg(null);
    send("/plugins/inspect", "POST", { path: p }).then((info) => setPreview({ path: p, info })).catch((e) => setMsg(e.message));
  };
  // From Browse: the logger downloads the zip and installs it only if it matches the sha256 the registry pins.
  const getPlugin = (id) => send("/plugins/get", "POST", { id }).then((r) => (loadPlugins(), loadReg(false), r));
  const install = () => {
    setBusy(true);
    (preview.id ? getPlugin(preview.id) : send("/plugins/install", "POST", { path: preview.path }).then((r) => (loadPlugins(), r)))
      .then((r) => (setMsg(`${r.name} is installed${r.pages.length ? ". It has a page in the sidebar" : ""}`), setPreview(null), setPath("")))
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(false));
  };
  const addDev = () => send("/plugins/dev", "POST", { path: devPath })
    .then((r) => (setMsg(`${r.name} runs from its folder now and reloads when you save`), setDevPath(""), loadPlugins()))
    .catch((e) => setMsg(e.message));
  const live = useRef(inspect);
  live.current = inspect;
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "enter" || t === "over") setOver(true);
      else if (t === "leave") setOver(false);
      else if (t === "drop") {
        setOver(false);
        if (e.payload.paths?.[0]) live.current(e.payload.paths[0]);
      }
    });
    return () => void off.then((f) => f());
  }, []);
  const plugins = d?.plugins || [];
  const confirm = preview && (
    <section className="card group pl-confirm">
      <Row label={`${preview.info.installed ? "Update" : "Install"} ${preview.info.name}`}
        hint={[preview.info.version && `v${preview.info.version}`, preview.info.author && `by ${preview.info.author}`,
          preview.info.installed && `you have v${preview.info.installed}`].filter(Boolean).join(" · ")} />
      {preview.info.description && <p className="pl-desc">{preview.info.description}</p>}
      {preview.info.uses.length > 0 && <ul className="pl-uses">{preview.info.uses.map((u) => <li key={u}>{u}</li>)}</ul>}
      {preview.id ? (
        <p className="pl-warn calm">Reviewed before it was listed, and Wavelog checks that the download is exactly that version. Like every plugin, it runs with the same rights as Wavelog.</p>
      ) : (
        <p className="pl-warn">A plugin can do anything Wavelog can, like reading files and using the internet. Only install it if you trust who made it.</p>
      )}
      <div className="pl-foot">
        <span className="grow" />
        {msg && <span className="hint">{msg}</span>}
        <button className="pill glass" onClick={() => (setPreview(null), setMsg(null))}>Cancel</button>
        <button className="primary" disabled={busy} onClick={install}>
          {busy ? (preview.id ? "Downloading…" : "Installing…") : preview.info.installed ? "Update" : "Install"}
        </button>
      </div>
    </section>
  );
  const pick = (e) => (setMsg(null), setPreview({ id: e.id, info: e }));
  return (
    <>
      <h4>Installed</h4>
      {plugins.length ? plugins.map((p) => <PluginCard key={p.id} p={p} setTab={setTab} update={d?.updates?.[p.id]} onUpdate={getPlugin} />) : (
        <section className="card group"><Row label="No plugins yet" hint="Plugins add pages, widgets and notch sections. Pick one below, or make your own" /></section>
      )}
      {d?.broken?.length > 0 && (
        <section className="card group">
          {d.broken.map((b) => <Row key={b.path} label="A plugin folder couldn't be read" hint={`${b.path}: ${b.error}`} />)}
        </section>
      )}
      <h4>Get plugins</h4>
      {preview?.id && confirm}
      <section className="card group pl-browse">
        {!reg ? <Row label="Loading the plugin list…" /> : reg.plugins.length === 0 ? (
          <Row label={reg.error ? "Couldn't load the plugin list" : "No plugins listed yet"} hint={reg.error}>
            <button className="link" onClick={() => (setReg(null), loadReg(true))}>Try again</button>
          </Row>
        ) : reg.plugins.map((e) => <BrowseRow key={e.id} e={e} pick={() => pick(e)} />)}
      </section>
      <p className="hint foot-note">
        Every plugin here was reviewed before it was listed. Want yours here? See github.com/rockslol/wavelog-plugins.
        {reg && <> <button className="link" onClick={() => loadReg(true)}>Refresh</button></>}
      </p>
      <h4>Install from a file</h4>
      <section className={"card group pl-drop" + (over ? " over" : "")}>
        <Row label="Install a plugin" hint="Drop a plugin's folder or .zip on this window, or paste where it is" />
        <div className="pl-path">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Downloads\my-plugin.zip" spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && path.trim() && inspect(path)} />
          <button className="pill glass" disabled={!path.trim()} onClick={() => inspect(path)}>Next</button>
        </div>
        {msg && !preview && <p className="hint pl-msg">{msg}</p>}
      </section>
      {preview?.path && confirm}
      <h4>Developer mode</h4>
      <section className="card group">
        <Row label="Load a folder" hint="Runs a plugin straight from its folder and reloads it every time you save a file. Nothing is copied" />
        <div className="pl-path">
          <input value={devPath} onChange={(e) => setDevPath(e.target.value)} placeholder="D:\code\my-plugin" spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && devPath.trim() && addDev()} />
          <button className="pill glass" disabled={!devPath.trim()} onClick={addDev}>Load</button>
        </div>
      </section>
      <p className="hint foot-note">
        Plugins run inside Wavelog's logger with the same rights as Wavelog. They never get your Spotify login. Removing a plugin keeps its saved data, so installing it again brings it back.
        {d?.folder && <> <button className="link" onClick={() => invoke("reveal", { path: d.folder })}>Open the plugins folder</button></>}
      </p>
    </>
  );
}
