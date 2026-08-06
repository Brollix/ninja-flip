import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { HistoryPoint } from "../types";
import { getPlatReconciliations, getPlatSnapshots, reconcilePlatSnapshots } from "../wfm";

const METRICS = [
  { key: "plat", label: "Platinum", fmt: (v: number) => `${Math.round(v)}p` },
  { key: "credits", label: "Credits", fmt: (v: number) => `${(v / 1e6).toFixed(2)}M` },
  { key: "endo", label: "Endo", fmt: (v: number) => v.toLocaleString() },
  { key: "ducats", label: "Ducats", fmt: (v: number) => v.toLocaleString() },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];
const STALE_AFTER_MS = 24 * 3600 * 1000;
const W = 900, H = 220, PAD_L = 52, PAD_R = 14, PAD_T = 12, PAD_B = 26;

export function HistoryChart({ history }: { history: HistoryPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>("plat");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [, force] = useState(0);

  const officialAll = useMemo(() =>
    history.filter(h => h.ts).map(h => ({ t: new Date(h.ts).getTime(), raw: h }))
      .sort((a, b) => a.t - b.t),
    [history]);
  const lastOfficial = officialAll[officialAll.length - 1] ?? null;

  // Plata: reconcilia contra el snapshot oficial más nuevo cada vez que
  // llega uno — ver reconcilePlatSnapshots en wfm.ts (guarda el desfasaje
  // como "movido por fuera de la app" y descarta las estimaciones viejas
  // que ya quedaron cubiertas por el dato real).
  useEffect(() => {
    if (!lastOfficial) return;
    reconcilePlatSnapshots(lastOfficial.t, lastOfficial.raw.plat);
    force(x => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastOfficial?.t, lastOfficial?.raw.plat]);

  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const official = officialAll.filter(p => p.t >= cutoff)
    .map(p => ({ t: p.t, v: p.raw.plat, raw: p.raw as HistoryPoint | null, estimated: false }));

  // Solo para "plat": el historial de Aleca es un punto por día (su sync);
  // esto agrega, además, cada compra/venta confirmada en la app desde el
  // último punto oficial — se mueve por acción, no solo por tiempo. Tramo
  // punteado hasta que un sync nuevo de Aleca lo confirme.
  const estimated = metric === "plat"
    ? getPlatSnapshots().filter(s => s.ts > (lastOfficial?.t ?? 0) && s.ts >= cutoff)
        .map(s => ({ t: s.ts, v: s.plat, raw: null as HistoryPoint | null, estimated: true }))
    : [];

  const pts = metric === "plat" ? [...official, ...estimated] : official.map(p => ({ ...p, v: p.raw![metric] }));
  const lastOfficialIdx = official.length - 1;

  if (pts.length < 2) return null;
  const m = METRICS.find(x => x.key === metric)!;

  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vMax = Math.max(...pts.map(p => p.v)) || 1;
  const vMin = Math.min(...pts.map(p => p.v));
  const sorted = [...pts.map(p => p.v)].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  // el eje Y llega hasta un poco más arriba del máximo real (no al máximo
  // justo) — la interpolación Catmull-Rom de abajo puede "pasarse" un poco
  // del dato real en un cambio de pendiente fuerte, y sin este margen la
  // curva quedaba dibujándose afuera del gráfico. Con margen de sobra, ese
  // rebote entra solo, sin tener que clampear nada (que se veía como un
  // corte artificial en vez de una curva real).
  const yScaleMax = vMax * 1.15;
  // el eje X va por ÍNDICE, parejo, no por el timestamp real — hay
  // exactamente un snapshot por día (confirmado con la data real), pero no
  // siempre a la misma hora, así que ubicar los puntos por su timestamp
  // crudo los desalineaba de las líneas verticales de "cada día" (que son
  // parejas por construcción). Con índice, cada punto cae EXACTO sobre su
  // línea — misma fuente para los dos, no pueden desalinearse. Los
  // snapshots propios (compra/venta) suman índices extra al final, con el
  // mismo criterio.
  const xi = (i: number) => PAD_L + (i / (pts.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - v / yScaleMax) * (H - PAD_T - PAD_B);

  // interpolación suave (Catmull-Rom → bezier con tensión baja) — la misma
  // función sirve para la curva real Y la de tendencia, así las dos se ven
  // consistentes en vez de una suave y la otra en línea recta quebrada.
  const smooth = (xyPts: { x: number; y: number }[]): string =>
    xyPts.map((p, i) => {
      if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      const p0 = xyPts[i - 2] ?? xyPts[i - 1], p1 = xyPts[i - 1], p2 = p, p3 = xyPts[i + 1] ?? p;
      const k = 0.18; // "un poco" de curva, sin exagerar
      const clampX = (v: number) => Math.min(Math.max(v, p1.x), p2.x);
      const c1x = clampX(p1.x + (p2.x - p0.x) * k), c1y = p1.y + (p2.y - p0.y) * k;
      const c2x = clampX(p2.x - (p3.x - p1.x) * k), c2y = p2.y - (p3.y - p1.y) * k;
      return `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }).join(" ");

  const xy = pts.map((p, i) => ({ x: xi(i), y: y(p.v) }));
  // línea confirmada (0..último oficial) y, si hay, el tramo estimado
  // (último oficial..final) — dos <path> separados para poder pintar el
  // segundo punteado sin tocar el primero.
  const confirmedPath = lastOfficialIdx >= 0 ? smooth(xy.slice(0, lastOfficialIdx + 1)) : "";
  const estimatedPath = estimated.length ? smooth(xy.slice(Math.max(lastOfficialIdx, 0))) : "";
  const area = `${smooth(xy)} L${xi(pts.length - 1).toFixed(1)},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`;

  // línea de tendencia: media móvil EXPONENCIAL (EMA) — el snapshot actual
  // pesa 1/3, y cada día hacia atrás pesa geométricamente menos que el
  // anterior, en vez de contar todos los días de la ventana por igual.
  const EMA_ALPHA = 1 / 3;
  let prevEma: number | null = null;
  const trendXy = pts.map((p, i) => {
    const ema = prevEma == null ? p.v : EMA_ALPHA * p.v + (1 - EMA_ALPHA) * prevEma;
    prevEma = ema;
    return { x: xi(i), y: y(ema) };
  });
  const trendPath = smooth(trendXy);

  // grilla horizontal en fracciones del máximo REAL (no del techo con margen)
  // — así la línea de arriba sigue mostrando el número real de tu pico.
  const gridVals = [0.25, 0.5, 0.75, 1].map(f => vMax * f);

  // el mouse traba en el snapshot más cercano por ÍNDICE (mismo eje que la
  // curva y las líneas de día) — nada de interpolar entre medio.
  const pxToIdx = (evX: number, rect: DOMRect) => {
    const px = ((evX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (px - PAD_L) / (W - PAD_L - PAD_R)));
    return Math.round(frac * (pts.length - 1));
  };
  const hp = hoverIdx != null ? pts[hoverIdx] : null;

  // Marcadores de reconciliación: plata movida por fuera de la app,
  // detectada cuando un snapshot oficial nuevo no coincidía con lo
  // estimado — se guardan con el mismo ts que el punto oficial que las
  // confirmó, así se ubican exacto.
  const recons = metric === "plat" ? getPlatReconciliations() : [];
  const reconMarkers = recons
    .map(r => ({ ...r, idx: official.findIndex(p => p.t === r.ts) }))
    .filter(r => r.idx >= 0);

  const stale = metric === "plat" && lastOfficial != null && Date.now() - lastOfficial.t > STALE_AFTER_MS;
  const staleHours = lastOfficial != null ? Math.floor((Date.now() - lastOfficial.t) / 3600000) : 0;

  return (
    <div className="card">
      <div className="chart-head">
        <div>
          <h2>Account history</h2>
          <p className="hint">
            last 7 days · {pts.length} snapshots · {new Date(t0).toLocaleDateString()} → {new Date(t1).toLocaleDateString()}
            {" "}· median {m.fmt(median)} · high {m.fmt(vMax)} · low {m.fmt(vMin)}
          </p>
          <div className="legend">
            <span className="lv">Actual{estimated.length > 0 && " (confirmed)"}</span>
            {estimated.length > 0 && <span className="lt">Estimated (your trades)</span>}
            {estimated.length === 0 && <span className="lt">Trend</span>}
          </div>
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
      {stale && (
        <p className="hint">
          <AlertTriangle size={13} className="inline-icon" /> AlecaFrame hasn't confirmed your plat in {staleHours}h —
          the dotted line past that point is our running estimate from your trades, not verified yet.
        </p>
      )}
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.label} history`}
             onMouseMove={e => setHoverIdx(pxToIdx(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect()))}
             onMouseLeave={() => setHoverIdx(null)}>
          {gridVals.map(v => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="gridline" />
              <text x={PAD_L - 8} y={y(v) + 3.5} className="axis-label" textAnchor="end">{m.fmt(v)}</text>
            </g>
          ))}
          {pts.map((p, i) => (
            <g key={p.t}>
              <line x1={xi(i)} x2={xi(i)} y1={PAD_T} y2={H - PAD_B} className="gridline" />
              <text x={xi(i)} y={H - 8} className="axis-label" textAnchor="middle">
                {p.estimated
                  ? new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : new Date(p.t).toLocaleDateString()}
              </text>
            </g>
          ))}
          <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} className="baseline" />
          <path d={area} className="chart-area" />
          {confirmedPath && <path d={confirmedPath} className="chart-line" />}
          {estimatedPath && <path d={estimatedPath} className="chart-line-estimated" />}
          {estimated.length === 0 && <path d={trendPath} className="chart-trend" />}
          {reconMarkers.map(r => (
            <circle key={r.ts} cx={xi(r.idx)} cy={y(official[r.idx].v)} r={4} className="chart-dot peak-dot">
              <title>{r.delta > 0 ? "+" : ""}{r.delta}p from outside the app (not a bought/sold logged here)</title>
            </circle>
          ))}
          {hp && (
            <g>
              <line x1={xi(hoverIdx!)} x2={xi(hoverIdx!)} y1={PAD_T} y2={H - PAD_B} className="crosshair" />
              <circle cx={xi(hoverIdx!)} cy={y(hp.v)} r={4} className="chart-dot" />
            </g>
          )}
        </svg>
        {hp && (
          <div className="chart-tip">
            <b>{m.fmt(hp.v)}</b> ·{" "}
            {hp.estimated
              ? <>{new Date(hp.t).toLocaleString()} <span className="muted">· estimated from your trades</span></>
              : <>{new Date(hp.t).toLocaleDateString()}
                  {hp.raw && <span className="muted"> · MR {hp.raw.mr} · {hp.raw.relicOpened} relics opened that day</span>}</>}
          </div>
        )}
      </div>
    </div>
  );
}
