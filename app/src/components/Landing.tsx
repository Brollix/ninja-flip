import { useEffect, useRef, useState } from "react";
import { BarChart3, ChevronDown, Gem, Link2, NotebookText, Radio } from "lucide-react";
import type { Flip } from "../types";
import { LoginForm } from "./Composer";
import { FlipsView } from "./views";
import { PeakTimeBadge } from "./PeakTime";

const FEATURES = [
  {
    Icon: BarChart3,
    title: "Flip scanner",
    body: "Scores sets, arcanes and mods by spread and liquidity — buy low, resell with confidence, not guesswork.",
  },
  {
    Icon: Gem,
    title: "Relic analysis",
    body: "Crosses your relic inventory with drop tables and ducat prices to tell you what's worth cracking.",
  },
  {
    Icon: NotebookText,
    title: "Profit ledger",
    body: "Tracks your closed flips over time, so you know if you're actually netting plat.",
  },
] as const;

/** Primera pantalla que ve cualquiera sin cuenta de wfm conectada — antes
 *  esto era un card mínimo con un título y el login solo. Sirve como
 *  landing real: qué es la app, qué la diferencia de wfm.market mismo, y
 *  quién la hace — para que no dependa de que alguien ya confíe a ciegas. */
export function Landing() {
  const [flips, setFlips] = useState<Flip[]>([]);
  const [flipsTs, setFlipsTs] = useState<number | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  // Data pública, sin auth — /api/flips no requiere JWT (ver flipsRouter en
  // el server). Se muestra acá mismo, sin login, como prueba de que la
  // herramienta funciona de verdad — no solo capturas.
  useEffect(() => {
    let stop = false;
    fetch("/api/flips", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ts: number; flips: Flip[] }) => {
        if (stop) return;
        setFlips(d.flips ?? []);
        setFlipsTs(d.ts ?? null);
      })
      .catch(() => { /* sin red: se queda vacío, no rompe la landing */ });
    return () => { stop = true; };
  }, []);

  return (
    <div className="landing">
      <div className="landing-narrow">
        <div className="landing-hero">
          <h1 className="landing-title">NinjaFlip</h1>
          <p className="landing-tagline">Turn Warframe platinum into more platinum.</p>
          <p className="hint standalone">
            A trading companion for warframe.market — not a replacement, an add-on for people who flip regularly.
          </p>
        </div>

        <div className="landing-features">
          {FEATURES.map(f => (
            <div className="landing-feature" key={f.title}>
              <f.Icon size={20} className="landing-feature-icon" />
              <div className="landing-feature-title">{f.title}</div>
              <p className="landing-feature-body">{f.body}</p>
            </div>
          ))}
        </div>

        <LoginForm />

        <button className="landing-scroll-cta"
                onClick={() => liveRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          Not sure yet? Scroll down to see it running live with real warframe.market data
          <ChevronDown size={32} className="landing-scroll-cta-chevron" />
        </button>
      </div>

      <div className="landing-live" ref={liveRef}>
        <div className="landing-live-label">
          <Radio size={22} className="inline-icon" /> Live data, no login required — see it working before you connect anything
        </div>
        <PeakTimeBadge />
        {flips.length > 0
          ? <FlipsView flips={flips} flipsTs={flipsTs} startPlat={0} preview />
          : <p className="hint standalone">Loading live flips…</p>}
      </div>

      <div className="landing-narrow">
        <p className="landing-disclaimer">
          Not affiliated with Digital Extremes or warframe.market.{" "}
          Built by <a href="https://warframe.market/profile/brollix" target="_blank" rel="noreferrer">Brollix</a>
          {" "}· <Link2 size={11} className="inline-icon" />{" "}
          <a href="https://www.patreon.com/c/ninjaflip" target="_blank" rel="noreferrer">Patreon</a>
        </p>
      </div>
    </div>
  );
}
