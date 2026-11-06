import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { get, hidden, useLyrics, usePoll, useSize } from "./api";
import Frame from "./Frame";

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export default function Widget() {
  const [now, setNow] = useState(null);
  const [stats, setStats] = useState({});
  const [offline, setOffline] = useState(false);
  const [, tick] = useState(0);
  const size = useSize();

  useEffect(() => {
    const poll = () =>
      !hidden && get("/now")
        .then((n) => (setNow({ ...n, at: Date.now() }), setOffline(false)))
        .catch(() => setOffline(true));
    const slow = () =>
      !hidden && Promise.all([get("/today"), get("/top/artists?range=week&limit=1"), get("/top/tracks?range=week&limit=1")])
        .then(([t, a, tr]) => setStats({ minutes: t.minutes, artist: a[0]?.name, track: tr[0]?.name }))
        .catch(() => {});
    poll();
    slow();
    const ids = [setInterval(poll, 2000), setInterval(slow, 60000)];
    return () => ids.forEach(clearInterval);
  }, []);
  const set = usePoll("/settings", 600000);
  const showLyrics = set?.now_lyrics !== false && size !== "s";
  useEffect(() => {
    const id = setInterval(() => !hidden && tick((x) => x + 1), showLyrics ? 500 : 1000);
    return () => clearInterval(id);
  }, [showLyrics]);

  const pos = now?.id ? Math.min(now.duration_ms, now.progress_ms + (now.playing ? Date.now() - now.at : 0)) : 0;
  const progress = now?.id ? pos / now.duration_ms : 0;
  const cover = now?.image ? <img className="cover" src={now.image} draggable={false} /> : <div className="cover" />;
  const title = <div className="title">{offline ? "Logger offline" : now?.name || "Nothing playing"}</div>;
  const artist = <div className="sub">{offline ? "Start the backend" : now?.artists}</div>;
  const bar = <div className="bar"><div style={{ width: progress * 100 + "%" }} /></div>;
  const ly = useLyrics(showLyrics ? now?.id : null, pos, now?.duration_ms);
  const at = Math.max(ly.i, 0);
  const lyrics = showLyrics && ly.lines.length > 0 && (
    <div className="np-lyrics">
      {ly.lines.slice(at, at + (size === "l" ? 4 : 2)).map(([t, text], k) => (
        <p key={t + text + k} className={ly.synced && at + k === ly.i ? "on" : ""}>{text || "♪"}</p>
      ))}
    </div>
  );

  return (
    <Frame className={"spotify" + (now?.playing ? "" : " paused")} hue={now?.color} onClick={() => invoke("open_stats")}>
      {size === "s" ? <>
        {cover}
        <div className="info">{title}{artist}</div>
        {bar}
      </> : size === "m" ? <>
        {cover}
        <div className="info">
          {title}
          {artist}
          {lyrics || <div className="grow" />}
          {bar}
          <div className="foot">
            <span>{stats.minutes ?? 0} min today</span>
            {stats.artist && <span>Top: {stats.artist}</span>}
          </div>
        </div>
      </> : <>
        <div className="top-row">
          {cover}
          <div className="info">{title}{artist}<div className="sub">{now?.album}</div></div>
        </div>
        <div>
          {bar}
          <div className="foot"><span>{clock(pos)}</span><span>{now?.id ? clock(now.duration_ms) : ""}</span></div>
        </div>
        {lyrics || (
          <div className="facts">
            <div><span>Today</span><b>{stats.minutes ?? 0} min</b></div>
            <div><span>Top artist this week</span><b>{stats.artist || "None"}</b></div>
            <div><span>Top track this week</span><b>{stats.track || "None"}</b></div>
          </div>
        )}
      </>}
    </Frame>
  );
}
