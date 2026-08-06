import { Check, X } from "lucide-react";

const PERKS = [
  "Suggested Positions — auto-picked flips fit to your free capital and daily trades",
  "Auto-undercut — one click fixes an out-of-position order, or does it for you automatically",
  "On-demand refresh — skip the cache and re-check your relic report right after a trade",
  "Auto-detected flip history — catches trades you made in-game even if you never logged them in the app",
];

/** Modal de "qué incluye Premium" — se abre desde el banner de Patreon
 *  cuando alguien conecta una cuenta que todavía no es patron activo. Solo
 *  describe lo que YA existe y funciona hoy — nada de prometer features que
 *  todavía no están construidas (ver memoria del proyecto, patreon-tiers). */
export function TierModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Premium tiers">
        <div className="modal-head">
          <h2>Premium</h2>
          <button className="linkish close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="hint">
          One tier, <b>$5/month</b> via Patreon — no separate account, just link the Patreon
          account you already used to pledge.
        </p>
        <ul className="tier-perks">
          {PERKS.map(p => (
            <li key={p}><Check size={14} className="inline-icon gain-pos" /> {p}</li>
          ))}
        </ul>
        <div className="composer-footer">
          <a className="btn primary big" href="https://www.patreon.com/c/ninjaflip" target="_blank" rel="noreferrer">
            Become a patron
          </a>
        </div>
      </div>
    </div>
  );
}
