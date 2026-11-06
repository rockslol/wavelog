import { useState } from "react";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVELS = [0.06, 0.2, 0.4, 0.65, 0.92];
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function level(v, max) {
  return v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
}

function Legend() {
  return (
    <div className="legend">
      <span>Less</span>
      {LEVELS.map((o, i) => <i key={o} className={"lv" + i} />)}
      <span>More</span>
    </div>
  );
}

function Shell({ title, hint, tip, children }) {
  return (
    <section className="card">
      <div className="head"><h3>{title}</h3><span className="hint">{hint}</span></div>
      <div className="chart">
        {children}
        {tip && (
          <div className="tip glass" style={{ left: tip.x, top: tip.y }}>
            <b>{tip.value}</b>
            <span>{tip.label}</span>
          </div>
        )}
      </div>
      <Legend />
    </section>
  );
}

export function CalendarHeat({ days, from, to, title = "Listening calendar" }) {
  const [tip, setTip] = useState(null);
  const by = Object.fromEntries(days.map((d) => [d.day, d.minutes]));
  const start = new Date(from);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells = [];
  for (let d = new Date(start), i = 0; d <= to; d.setDate(d.getDate() + 1), i++) {
    if (d >= from) cells.push({ key: iso(d), col: Math.floor(i / 7), row: i % 7, date: new Date(d), v: by[iso(d)] || 0 });
  }
  const cols = Math.max(...cells.map((c) => c.col), 0) + 1;
  const max = Math.max(1, ...cells.map((c) => c.v));
  const S = 13, G = 3, L = 30, T = 18;
  const months = cells.filter((c) => c.date.getDate() === 1 || c === cells[0]);
  const total = cells.reduce((a, c) => a + c.v, 0), active = cells.filter((c) => c.v).length;
  return (
    <Shell title={title} hint={`${active} days with music · ${total.toLocaleString("en-US")} min`} tip={tip}>
      <svg className="heat" viewBox={`0 0 ${L + cols * (S + G)} ${T + 7 * (S + G)}`} onPointerLeave={() => setTip(null)}>
        {months.map((c) => <text key={c.key} className="axis" x={L + c.col * (S + G)} y={11}>{MONTHS[c.date.getMonth()]}</text>)}
        {[0, 2, 4].map((r) => <text key={r} className="axis" x={0} y={T + r * (S + G) + 10}>{DOW[r]}</text>)}
        {cells.map((c) => (
          <rect key={c.key} x={L + c.col * (S + G)} y={T + c.row * (S + G)} width={S} height={S} rx={3}
            className={"lv" + level(c.v, max)} tabIndex={0}
            onPointerEnter={(e) => setTip(spot(e, `${c.v} min`, c.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })))}
            onFocus={(e) => setTip(spot(e, `${c.v} min`, c.key))} />
        ))}
      </svg>
    </Shell>
  );
}

export function HourHeat({ grid, title = "Hours by weekday", hint = "When you listen, in local time" }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(1, ...grid.flat());
  const S = 30, H = 22, G = 3, L = 36, B = 18;
  return (
    <Shell title={title} hint={hint} tip={tip}>
      <svg className="heat" viewBox={`0 0 ${L + 24 * (S + G)} ${7 * (H + G) + B}`} onPointerLeave={() => setTip(null)}>
        {DOW.map((d, r) => <text key={d} className="axis" x={0} y={r * (H + G) + 15}>{d}</text>)}
        {Array.from({ length: 8 }, (_, k) => k * 3).map((h) => (
          <text key={h} className="axis" x={L + h * (S + G)} y={7 * (H + G) + 13}>{pad(h)}</text>
        ))}
        {grid.map((row, r) => row.map((v, h) => (
          <rect key={r + "-" + h} x={L + h * (S + G)} y={r * (H + G)} width={S} height={H} rx={4}
            className={"lv" + level(v, max)} tabIndex={0}
            onPointerEnter={(e) => setTip(spot(e, `${v} min`, `${DOW[r]} ${pad(h)}:00 to ${pad(h + 1)}:00`))}
            onFocus={(e) => setTip(spot(e, `${v} min`, `${DOW[r]} ${pad(h)}:00`))} />
        )))}
      </svg>
    </Shell>
  );
}

function spot(e, value, label) {
  const box = e.currentTarget.closest(".chart").getBoundingClientRect(), r = e.currentTarget.getBoundingClientRect();
  return { value, label, x: Math.min(Math.max(r.left - box.left + r.width / 2, 80), box.width - 80), y: r.top - box.top };
}
