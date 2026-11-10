import { useEffect, useRef, useState } from "react";
import { usePoll } from "./api";
import Frame from "./Frame";
import Widget from "./Widget";
import { Calendar, Clock, Countdown, Lyrics, Note, Photos, System, Timer, Todo, Weather } from "./widgets";

const VIEWS = { widget: Widget, lyrics: Lyrics, calendar: Calendar, photos: Photos, weather: Weather, system: System, clock: Clock, countdown: Countdown, todo: Todo, timer: Timer, note: Note };

function saved() {
  try {
    return +localStorage.getItem("stack") || 0;
  } catch {
    return 0;
  }
}

export default function Stack() {
  const set = usePoll("/settings", 600000);
  const list = (set?.stack || []).filter((id) => VIEWS[id]);
  const [i, setI] = useState(saved);
  const last = useRef(0);
  useEffect(() => {
    try {
      localStorage.setItem("stack", String(i));
    } catch {}
  }, [i]);
  if (!set) return null;
  if (!list.length) return <Frame><p className="none">Choose widgets for the stack in Settings</p></Frame>;
  const at = i % list.length;
  const flip = (e) => {
    if (list.length < 2 || Date.now() - last.current < 450) return;
    last.current = Date.now();
    setI((at + (e.deltaY > 0 ? 1 : -1) + list.length) % list.length);
  };
  const View = VIEWS[list[at]];
  return (
    <div onWheel={flip}>
      <div key={list[at]} className="stack-page"><View /></div>
      {list.length > 1 && <div className="stack-dots">{list.map((id, k) => <i key={id} className={k === at ? "on" : ""} />)}</div>}
    </div>
  );
}
