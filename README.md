# Warframe · Platinum Trader

Trading assistant for warframe.market: flip scanner with live prices, order
management (post / adjust / close with one click), relic-cracking analysis
fed by AlecaFrame data, and a local SQLite ledger of completed flips.

## Structure

```
app/          React + TypeScript + Vite frontend (the dashboard)
scripts/      Python data pipeline
  relic_analysis.py   relic inventory × drop tables × market prices → report
  flips.py            prime-set flip scanner (spreads, liquidity, parts→set)
  aleca.py            quick CLI: account summary / trades / raw stats
  build_report.py     legacy static HTML report (superseded by app/)
cache/        downloaded data + generated reports (regenerable)
ledger.db     SQLite ledger: completed flips + cost basis (do not delete)
.env          AlecaFrame tokens (never commit)
```

## Run

```bash
# 1. refresh data (first run takes minutes; then 12h caches)
python scripts/relic_analysis.py --refresh
python scripts/flips.py --parts 12

# 2. start the dashboard
npm run dev --prefix app     # http://localhost:5173
```

The Vite dev server also provides:
- `/wfm/*` → proxy to api.warframe.market (the API has no CORS), with a
  global client-side rate limiter (~2.8 req/s, documented limit is 3/s per IP)
- `/ledger/*` → SQLite persistence for flips & cost basis (node:sqlite)

## Notes

- warframe.market session: login happens browser → market directly; the JWT
  stays in localStorage. Order books count only "online in game" users and
  exclude your own orders.
- AlecaFrame is used read-only via its public stats API (token in `.env`).
