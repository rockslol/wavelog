import { useEffect, useId, useRef, useState } from "react";

const H = 160;
const L = 44;
const compact = (v) => (v >= 10000 ? Math.round(v / 1000) + "K" : v.toLocaleString("en-US"));

function ticks(max) {
  const raw = Math.max(max, 4) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  return Array.from({ length: Math.ceil(Math.max(max, 1) / step) + 1 }, (_, i) => i * step);
}

export default function Columns({ title, data, unit = "min" }) {
  const box = useRef(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const grad = "g" + useId().replace(/\W/g, "");

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const t = ticks(Math.max(0, ...data.map((d) => d.value)));
  const y = (v) => H - (v / t[t.length - 1]) * H;
  const slot = (w - L) / data.length;
  const bw = Math.max(1, Math.min(24, slot - 2));
  const cx = (i) => L + slot * i + slot / 2;
  const h = hover !== null && data[hover];

  return (
    <section className="card">
      <div className="head">
        <h3>{title}</h3>
        <button className="link" onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      <div className="chart" ref={box} onPointerLeave={() => setHover(null)}>
        {table ? (
          <div className="table">
            <table>
              <tbody>
                {data.map((d, i) => (
                  <tr key={i}><td>{d.label}</td><td>{d.value.toLocaleString("en-US")} {unit}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : w > 0 && (
          <svg width={w} height={H + 30}>
            <defs>
              <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="g0" />
                <stop offset="1" className="g1" />
              </linearGradient>
            </defs>
            <g transform="translate(0,8)">
              {t.map((v) => (
                <g key={v}>
                  <line className={v ? "grid" : "base"} x1={L} x2={w} y1={y(v)} y2={y(v)} />
                  <text className="axis" x={L - 10} y={y(v)} textAnchor="end" dominantBaseline="middle">{compact(v)}</text>
                </g>
              ))}
              {data.map((d, i) => {
                if (!d.value) return null;
                const x = cx(i) - bw / 2, top = y(d.value), r = Math.min(6, bw / 2, H - top);
                return (
                  <path key={i} className={"col" + (i === hover ? " on" : "")} fill={`url(#${grad})`}
                    d={`M${x},${H}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${H}Z`} />
                );
              })}
              {data.map((d, i) => d.tick && (
                <text key={i} className="axis" x={cx(i)} y={H + 17} textAnchor="middle">{d.tick}</text>
              ))}
              {data.map((d, i) => (
                <rect key={i} x={L + slot * i} y={-8} width={slot} height={H + 8} fill="transparent" tabIndex={0}
                  aria-label={`${d.label}: ${d.value} ${unit}`}
                  onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
              ))}
            </g>
          </svg>
        )}
        {h && !table && (
          <div className="tip glass" style={{ left: Math.min(Math.max(cx(hover), 80), w - 80), top: y(h.value) }}>
            <b>{h.value.toLocaleString("en-US")} {unit}</b>
            <span>{h.label}</span>
          </div>
        )}
      </div>
    </section>
  );
}
