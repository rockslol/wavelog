// App updates from GitHub Releases (Tauri updater). Shared state so the sidebar and Settings > About agree.
import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const store = { state: "idle", update: null, error: null, progress: 0, checked: 0 };
const subs = new Set();
const set = (patch) => {
  Object.assign(store, patch);
  subs.forEach((f) => f({ ...store }));
};

export async function checkForUpdate() {
  if (store.state === "checking" || store.state === "installing") return;
  set({ state: "checking", error: null });
  try {
    const u = await check();
    set({ state: u ? "available" : "latest", update: u, checked: Date.now() });
  } catch (e) {
    // Offline or GitHub unreachable looks like this too, so it's never reported as "you're on the latest version".
    const msg = String(e?.message || e);
    const net = /valid release JSON|Could not fetch|error sending request|dns|timed? ?out|connect/i.test(msg);
    set({ state: "error", error: net ? "couldn't reach GitHub. Check your internet connection" : msg, checked: Date.now() });
  }
}

export async function installUpdate() {
  const u = store.update;
  if (!u || store.state === "installing") return;
  set({ state: "installing", progress: 0 });
  let total = 0, got = 0;
  try {
    await u.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength || 0;
      else if (e.event === "Progress") (got += e.data.chunkLength), set({ progress: total ? got / total : 0 });
    });
    await relaunch();
  } catch (e) {
    set({ state: "error", error: String(e?.message || e) });
  }
}

export function useUpdate() {
  const [s, setS] = useState({ ...store });
  useEffect(() => {
    subs.add(setS);
    return () => subs.delete(setS);
  }, []);
  return s;
}

let started = false;
export function startUpdateChecks() {
  if (started) return;
  started = true;
  setTimeout(checkForUpdate, 3000); // the stats window only exists while open, so check soon after it opens
  setInterval(checkForUpdate, 6 * 3600 * 1000);
}
