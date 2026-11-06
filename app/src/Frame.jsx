import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { hidden, usePoll, useSize } from "./api";
import { glass } from "./glass";

const backdrop = (force) =>
  hidden || document.hidden ? Promise.resolve(null) : invoke("backdrop", { force }).then((b) => {
    if (b.byteLength <= 8) return null;
    const v = new DataView(b);
    return { w: v.getUint32(0, true), h: v.getUint32(4, true), data: new Uint8Array(b, 8) };
  });

export default function Frame({ className = "", plain, onClick, hue, children }) {
  const canvas = useRef(null);
  const press = useRef(null);
  const size = useSize();
  const set = usePoll("/settings", 600000);
  const tint = useRef(0.4);
  tint.current = set?.tint ?? 0.4;
  const tone = useRef(null);
  tone.current = set?.cover_glass === false ? null : hue || null;

  useEffect(() => {
    if (plain) return;
    const ok = glass(canvas.current, backdrop, {
      inset: 16, radius: 24, tint: () => tint.current, hue: () => tone.current,
      onLight: (l) => document.documentElement.classList.toggle("light", !!l),
    });
    if (!ok) document.documentElement.classList.add("noglass");
  }, [plain]);

  const down = (e) => (press.current = [e.screenX, e.screenY]);
  const move = (e) => {
    if (press.current && !set?.locked && e.buttons === 1 && Math.hypot(e.screenX - press.current[0], e.screenY - press.current[1]) > 4) {
      press.current = null;
      getCurrentWindow().startDragging();
    }
  };
  const up = () => (press.current && onClick?.(), (press.current = null));

  return (
    <>
      {!plain && <canvas ref={canvas} className="glass-canvas" />}
      <div className={`widget size-${size} ${className}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onContextMenu={(e) => e.preventDefault()}>
        {children}
      </div>
    </>
  );
}
