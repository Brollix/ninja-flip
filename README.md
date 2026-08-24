<div align="center">

# 🥷 NinjaFlip
### Warframe Platinum Trader

[![Deploy](https://github.com/Brollix/ninja-flip/actions/workflows/deploy.yml/badge.svg)](https://github.com/Brollix/ninja-flip/actions/workflows/deploy.yml)

*A trading companion for [warframe.market](https://warframe.market) — not a
replacement, an add-on for people who flip regularly.*

> **Status:** the live deployment is currently paused (Cloud Run infra was
> torn down to stop billing while this project is on hold) — the app isn't
> reachable at the moment. Everything below still describes how it works;
> see [CLAUDE.md](CLAUDE.md) for the one-command reactivation steps.

</div>

---

## ✨ What it does

Sign in with your warframe.market account and NinjaFlip watches the market
for you: it scores what's actually worth flipping right now, keeps your live
orders competitive without you babysitting them, and tells you what your
relics are worth before you crack them.

| | |
|---|---|
| 📈 **Flip scanner** | Scores prime sets, arcanes and mods by spread and liquidity — buy low, resell with confidence, not guesswork. Parts→set arbitrage included. |
| 📋 **My Orders** | Every live buy/sell order checked against the best competing price. One click fixes an out-of-position order; one click records a sale and chains the resell. |
| 💎 **Relic analysis** | Crosses your relic inventory (via AlecaFrame) with drop tables and ducat prices to tell you what's worth cracking. |
| 📒 **Profit ledger** | Tracks your closed flips over time — so you know if you're *actually* netting plat. |
| ⏰ **Peak trading time** | Shows when the market's busiest right now, so your orders sit where the buyers and sellers actually are. |

### 🔓 Premium — via [Patreon](https://www.patreon.com/c/ninjaflip)

Active patrons unlock full automation: **auto-undercut** (orders stay
first-in-line by themselves), **auto-pause** (hidden outside peak hours,
back before the next one), and **auto-fill capital** (posts buy orders on
scanner picks until your free plat runs out).

## 🚀 Getting started

1. Open the app (once reactivated — see the Status note above) and sign in with your warframe.market account — no separate password.
2. *(optional)* Paste your AlecaFrame public link token (Stats tab → "Create Public Link") to unlock relic inventory, history and the profit ledger. Skip it and you still get the flip scanner and My Orders.
3. Trade — orders posted from the app show up on warframe.market like any other order.

*Not affiliated with Digital Extremes or warframe.market.*

---

## 🔧 Under the hood

Three services on Cloud Run + one shared Postgres (Neon), deployed
automatically on every push to `master`:

- **`server/`** (Node) — the public site + API, verifies your warframe.market login.
- **`scripts/report_server.py`** (Python, internal-only) — builds your relic/history report.
- **`scripts/flips.py`** — the market-wide scanner, cron every 10 min.

```bash
npm install --prefix app && npm run dev --prefix app   # local frontend, http://localhost:5173
```

More on the data model, deploy pipeline, and Terraform setup in [CLAUDE.md](CLAUDE.md).
