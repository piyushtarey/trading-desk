# Trading Desk — 3-Agent Sync

Mockup paper-trading desk: **Trade Scout → Trade Analyst → Trade Executor**.

A Next.js App Router UI that simulates a live multi-agent trading pipeline over 12 crypto pairs (Solana + EVM), with paper spot fills, perp tickets (EIP-712 / MetaMask signing on Arbitrum One), live price blending (CoinGecko → Binance → sim fallback), and Phantom / MetaMask / Demo wallet display.

> **Paper trading only.** No real orders are placed. Perp execution signs a local EIP-712 payload (`app/lib` domain `Trading Desk Perps`, chainId `42161`) — there is no on-chain settlement contract.

## Features

- **Dashboard (`/`)** — KPI strip (Total P&L, win rate, opportunities, fills), agent board, live activity feed (50), scheduled jobs, open spot positions.
- **Agents (`/agents`, `/agents/[id]`)** — Scout 🔭 / Analyst 🧠 / Executor ⚡ cards, cycles/tasks/heartbeats, per-agent signal scores, fills, event streams, full filterable history.
- **Perps Desk (`/perps`)** — ticket book (proposed → signed → executed / cancelled / expired, 90s TTL), open/closed perp positions with leverage, liq / TP / SL auto-close, manual close, MetaMask-gated execution.
- **History (`/history`)** — combined filterable timeline (type filter + text search + pagination + expandable JSON payloads).
- **Market simulation** — 2s tick (`TICK_MS`), random-walk + shocks over 12 seeded pairs, 48h deterministic seeded history on boot so first paint is populated.
- **Live prices** — `GET /api/prices` polls CoinGecko (primary) then Binance (fallback), in-memory 30s server cache, client polls every 15s; ticker badge shows `LIVE·BINANCE / LIVE·COINGECKO / STALE / SIM`.
- **Wallets** — Phantom (Solana, SOL balance via injected provider or `/api/sol-balance` proxy), MetaMask (EVM, EIP-6963 + legacy detection, Arbitrum One for perp signing), Demo paper wallet ($24,817.42). Persisted in `localStorage`, silent reconnect, account/chain listeners.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js `15.4.6` (App Router, Route Handlers) |
| UI | React `19.1.1`, Tailwind CSS v4 (CSS-first, no `tailwind.config.js`), custom `ink / mint / flame / gold / sky / violet` theme in `app/globals.css` |
| Language | TypeScript `5.7.2` (`strict`, `@/*` → `./*`) |
| Chain libs | `@solana/web3.js ^1.99.0` (installed; runtime uses injected providers + fetch, not direct web3.js calls) |
| State | Two React contexts — `WalletProvider` (outer) + `DeskProvider` (inner), client-only init, `setInterval` ticks |
| Styling | `postcss` + `@tailwindcss/postcss` |

## Quickstart

```powershell
npm install
npm run dev        # http://localhost:3000
```

Optional pre-flight:

```powershell
npm run typecheck  # tsc --noEmit
npm run build      # production build (stop dev server first — it clobbers .next)
npm run start      # serve production build
```

No `.env*` files are needed. All price/wallet integrations use public endpoints (CoinGecko, Binance, injected wallet providers, Solana mainnet-beta RPC via proxy). If a rate-limited CoinGecko key is ever added, keep it server-side only.

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `next dev` | Dev server |
| `build` | `next build` | Production build |
| `start` | `next start` | Serve built app |
| `typecheck` | `tsc --noEmit` | Type check |

## Project structure

```
app/
  layout.tsx            # Root layout: WalletProvider > DeskProvider > Sidebar + Header + main
  page.tsx              # Dashboard
  globals.css           # Tailwind v4 theme + keyframes/utilities
  agents/page.tsx       # 3-agent overview grid
  agents/[id]/page.tsx  # Agent detail (signals, fills, streams, history)
  history/page.tsx      # Combined timeline
  perps/page.tsx        # Perp ticket book + open/closed perps
  api/prices/route.ts   # GET /api/prices (CoinGecko → Binance, 30s cache)
  api/sol-balance/route.ts  # POST /api/sol-balance (Solana RPC proxy)
components/
  AgentBoard.tsx  Header.tsx  Sidebar.tsx  Ticker.tsx
  ActivityFeed.tsx  HistoryTable.tsx  KpiCards.tsx
  PositionsTable.tsx  ScheduleList.tsx  WalletButton.tsx  ui.tsx (Panel)
lib/
  types.ts    # All domain types (MarketPair, Opportunity, Analysis, Trade, Position, PerpTicket, PerpPosition, Job, Event)
  desk.ts     # DeskState, TICK_MS=2000, createJobs, PnL/equity/winRate helpers
  market.ts   # 12 PAIR_SEEDS, createMarket, tickMarket
  prices.ts   # COIN_TO_PAIR, applyLivePrices (direct + JUP/SOL, BONK/SOL, WBTC/ETH crosses)
  engine.ts   # runTick: scout → analyst → executor + jobs; perp marking/closing
  seed.ts     # Deterministic 48h history (mulberry32 seed 1337)
  store.tsx   # DeskProvider + useDesk (tick loop, price poll, perp execution)
  wallet.tsx  # WalletProvider + useWallet (Phantom/MetaMask/Demo, EIP-6963, EIP-712 signing)
  format.ts   # fmtUsd/fmtPct/fmtQty/fmtTime/fmtDuration/...
  rng.ts      # mulberry32, clamp, randBetween, pick, uid
```

## Routes

| Route | File | Description |
|---|---|---|
| `/` | `app/page.tsx` | KPIs + agents + activity/schedule + positions |
| `/agents` | `app/agents/page.tsx` | Scout/Analyst/Executor overview |
| `/agents/[id]` | `app/agents/[id]/page.tsx` | Detail: stats, current task, signals, fills, streams |
| `/perps` | `app/perps/page.tsx` | Ticket book, open/closed perps |
| `/history` | `app/history/page.tsx` | Combined timeline (`HistoryTable pageSize=50`) |
| `GET /api/prices` | `app/api/prices/route.ts` | Live price feed (see `docs/API.md`) |
| `POST /api/sol-balance` | `app/api/sol-balance/route.ts` | SOL balance proxy (see `docs/API.md`) |

## How it works (summary)

1. **Boot** — `DeskProvider` creates initial state client-side (`createMarket` + `seedHistory`), avoiding hydration mismatch with a `BootScreen`.
2. **Tick (every 2s)** — `runTick` (`lib/engine.ts:60`): `tickMarket` → `markPositions`/`markPerps` → `scoutPhase` (heat > 0.75, max 1–2/tick) → `analystPhase` (weighted score `m0.34+l0.22+v0.18+t0.26+14`, BUY ≥ 62 / WATCH ≥ 44, tickets only BUY ≥ 68) → `executorPhase` (spot paper fills, max 3 positions) → `runDueJobs` (6 jobs: 20s scan/analysis/exec, 5m rebalance, 2m risk, 1m heartbeat).
3. **Live blend (every 15s)** — client fetches `/api/prices`, `applyLivePrices` (`lib/prices.ts`) updates price/prev/change/spark/volatility/`liveLastAt`; uncovered pairs keep simulating.
4. **Perps** — analyst creates tickets (2–10x, ≥ $500 margin, 90s TTL, EIP-712 order); user executes via `executePerpTicket` → `signPerpOrder` (MetaMask `eth_signTypedData_v4` on Arbitrum, demo = fake `0x…` after 450ms) → `PerpPosition` opens; `markPerps` auto-closes on liq/TP/SL (floor −98%).
5. **Wallets** — display/balance only for spot; signing only for perp tickets. See `docs/WALLET.md`.

## Docs

- `docs/ARCHITECTURE.md` — system layout, providers, data flow
- `docs/SETUP.md` — install, run, build, troubleshooting
- `docs/FRONTEND.md` — routes, components, props
- `docs/DATA_MODEL.md` — types and entity lifecycles
- `docs/ENGINE.md` — simulation, scoring, jobs, seed history
- `docs/API.md` — `/api/prices`, `/api/sol-balance` contracts
- `docs/WALLET.md` — Phantom / MetaMask / Demo, detection, signing

## Notes / limitations

- `lib/desk.ts:123` `totalPnl` currently returns unrealized only (realized loop is a no-op); `equity`/`realizedPnl`/`winRate` use average-cost accounting and are the source of truth for closed P&L.
- `components/ActivityFeed.tsx` `showAgent` prop is accepted but currently renders `{showAgent && null}` (no-op).
- `@solana/web3.js` is a dependency but no source file imports it directly.
- `.freebuff/` (local preview logs/scratch), `node_modules/`, `.next/`, `*.tsbuildinfo`, `dev.log` are git-ignored.
