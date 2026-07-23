import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { copyText, marketUrl } from "../lib";

// ---------- ordenamiento ----------

export interface Col<T> {
  key: string;
  label: ReactNode;
  num?: boolean;
  title?: string;
  /** valor usado para ordenar; si falta, no ordenable */
  sortVal?: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({ cols, rows, defaultSort, defaultDir = -1, maxRows }: {
  cols: Col<T>[];
  rows: T[];
  defaultSort: string;
  defaultDir?: 1 | -1;
  maxRows?: number;
}) {
  const [sortKey, setSortKey] = useState(defaultSort);
  const [dir, setDir] = useState<1 | -1>(defaultDir);
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    const col = cols.find(c => c.key === sortKey);
    if (!col?.sortVal) return rows;
    const sv = col.sortVal;
    return [...rows].sort((a, b) => {
      const va = sv(a), vb = sv(b);
      const cmp = typeof va === "string"
        ? va.localeCompare(String(vb))
        : (va as number) - (vb as number);
      return cmp * dir;
    });
  }, [rows, cols, sortKey, dir]);

  const visible = maxRows && !showAll ? sorted.slice(0, maxRows) : sorted;

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key}
                  className={`${c.num ? "num" : ""} ${sortKey === c.key ? "sorted" : ""} ${c.sortVal ? "sortable" : ""}`}
                  title={c.title}
                  onClick={() => {
                    if (!c.sortVal) return;
                    if (sortKey === c.key) setDir(d => (d === 1 ? -1 : 1));
                    else {
                      setSortKey(c.key);
                      const sample = rows[0] ? c.sortVal(rows[0]) : 0;
                      setDir(typeof sample === "string" ? 1 : -1);
                    }
                  }}>
                {c.label}{sortKey === c.key ? (dir === -1 ? " ▾" : " ▴") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c.key} className={c.num ? "num" : ""}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {maxRows && sorted.length > maxRows && (
        <button className="btn more" onClick={() => setShowAll(s => !s)}>
          {showAll ? "show less" : `show ${sorted.length - maxRows} more`}
        </button>
      )}
    </div>
  );
}

// ---------- piezas chicas ----------

export function CopyBtn({ text, label }: { text: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className={`btn ${ok ? "ok" : ""}`}
            onClick={() => copyText(text).then(() => {
              setOk(true);
              setTimeout(() => setOk(false), 1400);
            })}>
      {ok ? "✓ copiado" : label}
    </button>
  );
}

export function MarketLink({ name, slug, children }: { name?: string; slug?: string; children?: ReactNode }) {
  return (
    <a className="item-link" target="_blank" rel="noreferrer"
       href={marketUrl(slug ?? name ?? "", !!slug)}
       title="Ver en warframe.market">
      {children ?? name}
    </a>
  );
}

export function Tag({ kind, children, title }: { kind?: string; children: ReactNode; title?: string }) {
  return <span className={`tag ${kind ?? ""}`} title={title}>{children}</span>;
}

export function VolBadge({ vol }: { vol: number }) {
  if (vol < 5) return <span className="lowvol" title="Low demand: may take a while to sell">{vol} ⚠</span>;
  return <>{vol}</>;
}

export function Tile({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="tile">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}
