import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export let hidden = false;
const reloads = new Set();
if (getCurrentWindow().label !== "stats") {
  getCurrentWindow().isVisible().then((v) => (hidden = !v));
  listen("visibility", (e) => ((hidden = !e.payload), e.payload && reloads.forEach((f) => f())));
  listen("settings", () => reloads.forEach((f) => f()));
  listen("overlay", (e) => {
    document.documentElement.classList.toggle("overlay", e.payload);
    if (e.payload) document.documentElement.classList.remove("light");
  });
}

export const API = "http://127.0.0.1:8721";
export const get = (path) => fetch(API + path).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

export function usePoll(path, ms) {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => !hidden && get(path).then((d) => live && setData(d)).catch(() => live && setData(null));
    load();
    reloads.add(load);
    const id = setInterval(load, ms);
    return () => ((live = false), clearInterval(id), reloads.delete(load));
  }, [path, ms]);
  return data;
}

const sizeOf = () => (innerWidth < 260 ? "s" : innerHeight > 260 ? "l" : "m");

export function useSize() {
  const [size, setSize] = useState(sizeOf());
  useEffect(() => {
    const f = () => setSize(sizeOf());
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return size;
}

export function useLyrics(id, pos, duration) {
  const ly = usePoll(id ? "/lyrics?id=" + id : null, 3600000);
  const ready = !!ly && ly.id === id;
  const synced = ready && ly.lines.length > 0;
  const lines = synced ? ly.lines : ready ? ly.plain.split("\n").filter(Boolean).map((t) => [0, t]) : [];
  const i = synced ? lines.findLastIndex(([t]) => t <= pos + 250) : Math.floor((pos / (duration || 1)) * lines.length);
  return { ready, synced, lines, i };
}

export const NOTCH_SECTIONS = [["clock", "Clock and weather"], ["music", "Music"], ["timer", "Focus timer"], ["calendar", "Next event"],
  ["pc", "PC load"], ["listening", "Listening today"], ["todos", "To do"], ["valorant", "Last Valorant match"]];
export const NOTCH = {
  idle: "weather", open: "hover", autohide: true, monitor: "", lyrics: true, viz: true, glow: true, accent: "album", peek: true, osd: true, scroll: true, alerts: true,
  sections: NOTCH_SECTIONS.map(([id]) => id),
};
export const notchOptions = (s) => ({ ...NOTCH, ...(s?.notch || {}) });
