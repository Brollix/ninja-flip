import { useEffect, useMemo, useState } from "react";
import { Flame, Clock } from "lucide-react";

interface Bucket { ts: string; volume: number }

// Compartido a nivel módulo (no por-instancia del hook) — PeakTimeBadge (en
// el header, siempre montado) y PeakTimeChart (dentro de FlipsView) llamaban
// usePeakTimeData() cada uno por su cuenta, así que tener las dos montadas
// a la vez disparaba el mismo fetch dos veces. Con esto, el segundo caller
// reusa el fetch en vuelo del primero, y un resultado de menos de
// SHARED_TTL_MS no vuelve a pedirse en absoluto.
const SHARED_TTL_MS = 60_000;
let sharedBuckets: Bucket[] | null = null;
let sharedAt = 0;
let sharedPromise: Promise<Bucket[]> | null = null;

function fetchPeakTimeShared(): Promise<Bucket[]> {
  if (sharedBuckets && Date.now() - sharedAt < SHARED_TTL_MS) {
    return Promise.resolve(sharedBuckets);
  }
  if (!sharedPromise) {
    sharedPromise = fetch("/api/peak-time", { cache: "no-store" })
      .then(r => r.json())
      .then((d): Bucket[] => {
        const buckets: Bucket[] = d.buckets ?? [];
        sharedBuckets = buckets;
        sharedAt = Date.now();
        return buckets;
      })
      .catch((): Bucket[] => sharedBuckets ?? []) // sin red: no hay badge/gráfico, no rompe nada
      .finally(() => { sharedPromise = null; });
  }
  return sharedPromise;
}

/** Fetch crudo de los baldes horarios cronológicos (volumen agregado de
 *  todos los items escaneados, ventana real de 48h — techo de granularidad
 *  horaria que da la API de wf.market) — compartido entre el badge de
 *  texto y el gráfico. */
function usePeakTimeData(): Bucket[] {
  const [buckets, setBuckets] = useState<Bucket[]>(sharedBuckets ?? []);
  useEffect(() => {
    let stop = false;
    fetchPeakTimeShared().then(b => { if (!stop) setBuckets(b); });
    return () => { stop = true; };
  }, []);
  return buckets;
}

/** Hora UTC de mayor volumen agregado (plegando los baldes por hora del día,
 *  para poder predecir "cuánto falta") + si estamos adentro de esa hora
 *  ahora mismo o cuánto falta. Dato público, gratis — mismo criterio que el
 *  resto de lo que se muestra sin login: cuesta lo mismo generarlo para 1
 *  usuario que para todos. */
export function usePeakTime() {
  const buckets = usePeakTimeData();
  if (!buckets.length) return null;
  // Plegado en la hora LOCAL del navegador (getHours, no getUTCHours) — cada
  // usuario ve el patrón según su propia zona horaria, no UTC fijo.
  const byHour = new Map<number, number>();
  for (const b of buckets) {
    const h = new Date(b.ts).getHours();
    byHour.set(h, (byHour.get(h) ?? 0) + b.volume);
  }
  let peakHour = 0, peakVol = -1;
  for (const [h, v] of byHour) if (v > peakVol) { peakVol = v; peakHour = h; }
  const now = new Date();
  const curHour = now.getHours();
  const isPeakNow = curHour === peakHour;
  const nowMins = curHour * 60 + now.getMinutes();
  const peakMins = peakHour * 60;
  // minutos desde la última ocurrencia pasada (0-1439) y hasta la próxima —
  // se repite cada 24h, así que ambos se derivan del mismo módulo.
  const minsSince = ((nowMins - peakMins) % 1440 + 1440) % 1440;
  const minsUntil = (1440 - minsSince) % 1440;
  return { peakHour, isPeakNow, minsUntil, minsSince };
}

function fmtHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function PeakTimeBadge() {
  const peak = usePeakTime();
  if (!peak) return null;
  const { isPeakNow, peakHour, minsUntil, minsSince } = peak;
  // Si el pico pasó hace poco (<12h) es más útil decir "hace cuánto" que
  // "falta 22h" para el próximo — evita que un pico reciente se sienta lejano.
  const wasRecent = !isPeakNow && minsSince < 12 * 60;
  return (
    <span className="peak-badge" title={`Busiest trading hour across all scanned items: ${fmtHour(peakHour)}`}>
      {isPeakNow
        ? <><Flame size={13} className="inline-icon" /> Peak trading hour — now</>
        : wasRecent
        ? <><Flame size={13} className="inline-icon" /> Peak trading hour was {Math.floor(minsSince / 60)}h {minsSince % 60}m ago</>
        : <><Clock size={13} className="inline-icon" /> Peak trading in {Math.floor(minsUntil / 60)}h {minsUntil % 60}m</>}
    </span>
  );
}

// ---------- curva de actividad (estilo steamdb) ----------

const W = 900, H = 130, PAD_L = 40, PAD_R = 10, PAD_T = 10, PAD_B = 20;
const HOUR_MS = 3_600_000;

// Sin timeZone explícito: usa la zona horaria local del navegador del
// usuario, no UTC fijo — cada quien ve el patrón en su propia hora.
function fmtTick(t: number): string {
  const d = new Date(t);
  return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", hour12: false }).replace(",", "");
}

function fmtTooltip(t: number): string {
  const d = new Date(t);
  return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
}

export function PeakTimeChart() {
  const buckets = usePeakTimeData();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Ventana real, cronológica (no plegada por hora del día) — rellena
  // huecos de horas sin datos con 0 para que la curva no salte.
  const data = useMemo(() => {
    if (!buckets.length) return [] as { t: number; v: number }[];
    const byTs = new Map(buckets.map(b => [new Date(b.ts).getTime(), b.volume]));
    const times = Array.from(byTs.keys()).sort((a, b) => a - b);
    const start = times[0], end = times[times.length - 1];
    const out: { t: number; v: number }[] = [];
    for (let t = start; t <= end; t += HOUR_MS) out.push({ t, v: byTs.get(t) ?? 0 });
    return out;
  }, [buckets]);

  if (!data.length) return null;

  const start = data[0].t, end = data[data.length - 1].t;
  const span = Math.max(end - start, HOUR_MS);
  const vals = data.map(d => d.v);
  const vMax = Math.max(...vals) || 1;
  const vMin = Math.min(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const nowT = Math.min(Math.max(Date.now(), start), end);

  // Amplificación vertical: en vez de mapear el volumen real 1:1 a la
  // altura del gráfico (donde un vaivén real de +-20% se ve casi plano),
  // exagera la distancia de cada punto a la media por GAIN — el patrón se
  // vuelve visible a costa de que la altura ya no sea proporcional al
  // volumen absoluto (por eso el eje Y sigue mostrando los valores reales,
  // no los amplificados).
  const GAIN = 3;
  const amp = (v: number) => mean + (v - mean) * GAIN;
  const ampMin = amp(vMin), ampMax = amp(vMax);
  const ampPad = Math.max((ampMax - ampMin) * 0.15, 1);
  const yDomainMin = ampMin - ampPad;
  const yDomainMax = ampMax + ampPad;
  const yRange = yDomainMax - yDomainMin || 1;

  const xi = (t: number) => PAD_L + ((t - start) / span) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (amp(v) - yDomainMin) / yRange) * (H - PAD_T - PAD_B);

  // Detección de patrón: promedia el volumen por hora del día (local) en
  // vez de mirar un solo pico puntual — así se ve la hora que se repite
  // como la más movida, no solo la que ganó por casualidad en esta ventana.
  const hourAvg = new Map<number, { sum: number; n: number }>();
  for (const d of data) {
    const h = new Date(d.t).getHours();
    const cur = hourAvg.get(h) ?? { sum: 0, n: 0 };
    hourAvg.set(h, { sum: cur.sum + d.v, n: cur.n + 1 });
  }
  let peakHourOfDay = 0, peakHourOfDayAvg = -1;
  for (const [h, { sum, n }] of hourAvg) {
    const avg = sum / n;
    if (avg > peakHourOfDayAvg) { peakHourOfDayAvg = avg; peakHourOfDay = h; }
  }
  const peakIndices = data
    .map((d, i) => ({ i, h: new Date(d.t).getHours() }))
    .filter(({ h }) => h === peakHourOfDay)
    .map(({ i }) => i);

  // Interpolación suave tipo Bezier (Catmull-Rom con tensión baja) para suavizar la curva de actividad
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

  const xy = data.map(d => ({ x: xi(d.t), y: y(d.v) }));
  const path = smooth(xy);
  const area = `${path} L${xi(end).toFixed(1)},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`;
  // Valores reales (no amplificados) para las etiquetas del eje — la
  // transformación solo afecta DÓNDE se dibujan, el número mostrado es
  // siempre el volumen real.
  const gridVals = [0, 1 / 3, 2 / 3, 1].map(f => vMin + f * (vMax - vMin));

  // ticks cada 6h desde el primer balde, más el último punto real.
  const labelTicks: number[] = [];
  for (let t = start; t <= end; t += 6 * HOUR_MS) labelTicks.push(t);

  const pxToIdx = (evX: number, rect: DOMRect) => {
    const px = ((evX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (px - PAD_L) / (W - PAD_L - PAD_R)));
    return Math.round(frac * (data.length - 1));
  };

  return (
    <div className="peak-chart-compact">
      <h3>Trading activity, last {Math.round(span / HOUR_MS)}h</h3>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trading activity over time"
             onMouseMove={e => setHoverIdx(pxToIdx(e.clientX, (e.currentTarget as SVGSVGElement).getBoundingClientRect()))}
             onMouseLeave={() => setHoverIdx(null)}>
          {gridVals.map(v => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="gridline" />
              <text x={PAD_L - 8} y={y(v) + 3.5} className="axis-label" textAnchor="end">{Math.round(v)}</text>
            </g>
          ))}
          {labelTicks.map(t => (
            <text key={t} x={xi(t)} y={H - 6} className="axis-label" textAnchor="middle">{fmtTick(t)}</text>
          ))}
          <line x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B} className="baseline" />
          <path d={area} className="chart-area" />
          <path d={path} className="chart-line" />
          {/* patrón detectado: marca CADA aparición de la hora del día que
              en promedio es la más movida (no solo el pico puntual de esta
              ventana) — así se ve que se repite, no que fue casualidad. */}
          {peakIndices.map(i => (
            <circle key={i} cx={xi(data[i].t)} cy={y(data[i].v)} r={4} className="chart-dot peak-dot" />
          ))}
          {/* "ahora": línea vertical siempre visible, no solo al pasar el mouse */}
          <line x1={xi(nowT)} x2={xi(nowT)} y1={PAD_T} y2={H - PAD_B} className="now-line" />
          <text x={xi(nowT)} y={PAD_T - 2} className="axis-label now-label" textAnchor="middle">now</text>
          {hoverIdx != null && (
            <g>
              <line x1={xi(data[hoverIdx].t)} x2={xi(data[hoverIdx].t)} y1={PAD_T} y2={H - PAD_B} className="crosshair" />
              <circle cx={xi(data[hoverIdx].t)} cy={y(data[hoverIdx].v)} r={4} className="chart-dot" />
            </g>
          )}
        </svg>
        {hoverIdx != null && (
          <div className="chart-tip">
            <b>{data[hoverIdx].v}</b> sales · {fmtTooltip(data[hoverIdx].t)}
          </div>
        )}
      </div>
    </div>
  );
}
