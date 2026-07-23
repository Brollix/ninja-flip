import { useMemo, useState } from "react";
import type { HistoryPoint } from "../types";

const METRICS = [
  { key: "plat", label: "Platinum", fmt: (v: number) => `${Math.round(v)}p` },
  { key: "credits", label: "Credits", fmt: (v: number) => `${(v / 1e6).toFixed(2)}M` },
  { key: "endo", label: "Endo", fmt: (v: number) => v.toLocaleString() },
  { key: "ducats", label: "Ducats", fmt: (v: number) => v.toLocaleString() },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

const W = 900, H = 220, PAD_L = 52, PAD_R = 14, PAD_T = 12, PAD_B = 26;

export function HistoryChart({ history }: { history: HistoryPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>("plat");
  const [hover, setHover] = useState<number | null>(null);

  const pts = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    return history
      .filter(h => h.ts)
      .map(h => ({ t: new Date(h.ts).getTime(), v: h[metric] ?? 0, raw: h }))
      .filter(p => p.t >= cutoff)
      .sort((a, b) => a.t - b.t);
  }, [history, metric]);

  if (pts.length < 2) return null;
  const m = METRICS.find(x => x.key === metric)!;

  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vMax = Math.max(...pts.map(p => p.v)) || 1;
  const x = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / vMax) * (H - PAD_T - PAD_B);

  // interpolación suave (Catmull-Rom → bezier con tensión baja)
  const xy = pts.map(p => ({ x: x(p.t), y: y(p.v) }));
  const path = xy.map((p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const p0 = xy[i - 2] ?? xy[i - 1], p1 = xy[i - 1], p2 = p, p3 = xy[i + 1] ?? p;
    const k = 0.25; // "un poco" de curva, sin exagerar
    const clampX = (v: number) => Math.min(Math.max(v, p1.x), p2.x);
    const c1x = clampX(p1.x + (p2.x - p0.x) * k), c1y = p1.y + (p2.y - p0.y) * k;
    const c2x = clampX(p2.x - (p3.x - p1.x) * k), c2y = p2.y - (p3.y - p1.y) * k;
    return `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }).join(" ");
  const area = `${path} L${x(t1).toFixed(1)},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`;

  const gridVals = [0.25, 0.5, 0.75, 1].map(f => vMax * f);
  const hp = hover != null ? pts[hover] : null;

  const nearest = (evX: number, rect: DOMRect) => {
    const px = ((evX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  return (
    <div className="card">
      <div className="chart-head">
        <div>
          <h2>Account history</h2>
          <p className="hint">last 7 days · {pts.length} snapshots · {new Date(t0).toLocaleDateString()} → {new Date(t1).toLocaleDateString()}</p>
        </div>
        <div className="chips">
          {METRICS.map(mm => (
            <button key={mm.key}
                    className={`chip ${metric === mm.key ? "active" : ""}`}
                    onClick={() => setMetric(mm.key)}>
              {mm.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.label} history`}
             onMouseMove={e => setHover(nearest(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect()))}
             onMouseLeave={() => setHover(null)}>
          {gridVals.map(v => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="gridline" />
              <text x={PAD_L - 8} y={y(v) + 3.5} className="axis-label" textAnchor="end">{m.fmt(v)}</text>
            </g>
          ))}
          <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} className="baseline" />
          <text x={PAD_L} y={H - 8} className="axis-label">{new Date(t0).toLocaleDateString()}</text>
          <text x={W - PAD_R} y={H - 8} className="axis-label" textAnchor="end">{new Date(t1).toLocaleDateString()}</text>
          <path d={area} className="chart-area" />
          <path d={path} className="chart-line" />
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD_T} y2={H - PAD_B} className="crosshair" />
              <circle cx={x(hp.t)} cy={y(hp.v)} r={4} className="chart-dot" />
            </g>
          )}
        </svg>
        {hp && (
          <div className="chart-tip">
            <b>{m.fmt(hp.v)}</b> · {new Date(hp.t).toLocaleDateString()}
            <span className="muted"> · MR {hp.raw.mr} · {hp.raw.relicOpened} relics opened that day</span>
          </div>
        )}
      </div>
    </div>
  );
}
