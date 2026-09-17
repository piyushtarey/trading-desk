# Architecture

## System overview

```
Browser (React 19 Client Components)
├── WalletProvider (lib/wallet.tsx) — outer
│   └── DeskProvider (lib/store.tsx) — inner
│       ├── Sidebar + Header (Ticker + WalletButton)
│       └── Pages: / , /agents[/id], /perps, /history
│
├── Tick loop (every TICK_MS=2000, lib/desk.ts:38)
│   └── runTick(state) (lib/engine.ts:60)
│       ├── markPositions → markPerps (on live-blended pairs; stale holds)
│       ├── scoutPhase (fresh-live pairs only) → analystPhase → executorPhase
│       └── runDueJobs (6 scheduled jobs)
│
├── Price poll (every 15s, lib/store.tsx)
│   └── GET /api/prices → applyLivePrices (lib/prices.ts)
│
└── Server Route Handlers
    ├── GET /api/prices (CoinGecko → Binance, 30s in-memory cache)
    └── POST /api/sol-balance (Solana mainnet-beta RPC proxy)
```

Root shell is defined in `app/layout.tsx:13`: `<WalletProvider><DeskProvider><Sidebar/><Header/><main/></DeskProvider></WalletProvider>`.

## Providers

### `WalletProvider` (`lib/wallet.tsx`)

- Owns `WalletState`: `connected, kind (phantom|metamask|demo), address, balance, balanceSymbol, network, connecting, error, demoFallback, demoBalanceUsd ($24,817.42), detected {phantom, metamask}`.
- Actions: `connect(kind), disconnect(), refreshBalance(), switchToArbitrum(), signPerpOrder(ticket)`.
- Persists `kind` in `localStorage` (`tradingdesk.wallet.v2`); silent reconnect on mount (Phantom `onlyIfTrusted`, MetaMask `eth_accounts`); listens for account/chain changes; refreshes real balances every 30s.
- No dependency on desk state. Desk consumes it only for perp signing (`executePerpTicket` calls `signPerpOrder`).

### `DeskProvider` (`lib/store.tsx`)

- Owns full `DeskState` (`lib/desk.ts:15`): `running, tick, now, pairs, opportunities, analyses, positions, trades, events, agents, jobs, startedAt, marketSource, lastLiveAt, tickets, perpPositions`.
- Context value: `{ state, toggleRunning, toggleJob, runJobNow, executePerpTicket, cancelTicket, closePerp, execError, clearExecError }`.
- Client-only boot: `state` starts `null`, `createInitialState(Date.now())` runs in `useEffect` (pair shells + empty books + `createJobs` + `createAgentRuntimes`), rendering `<BootScreen/>` until ready (avoids hydration mismatch).
- Two intervals:
  - `TICK_MS` (2s): if `!running`, only `now` updates; else deep-clone slices and call `runTick(next)`.
  - `POLL_MS` (15s): `fetch("/api/prices", {cache:"no-store"})` → `applyLivePrices` → set `marketSource/lastLiveAt`; errors swallowed (last values hold, scout idles until the feed recovers).

## Data flow

1. **Market** — `lib/market.ts`: 12 `PAIR_SEEDS` define the pair universe; `createMarket()` builds bootstrap shells (reference price, `change24h: 0`, `liveLastAt: null`). All movement comes from live blends; stale pairs hold last values.
2. **Live blend** — `lib/prices.ts`: `COIN_TO_PAIR` maps 12 CoinGecko IDs → pair IDs. Direct hits update price/prev/change/spark/volume/liquidity/volatility; synthetic crosses computed as `JUP/SOL = JUPUSD/SOLUSD`, `BONK/SOL = BONKUSD/SOLUSD`,    `WBTC/ETH = WBTCUSD/ETHUSD`, changes derived from legs when not supplied directly. First live hit sets `prevPrice = hit` to avoid a fake flash. Uncovered pairs hold last values (`liveLastAt` reveals staleness; the scout ignores them).
3. **Agents** — `lib/engine.ts` `runTick`: scout finds opportunities (heat `|change|/8 + vol*0.5 > 0.75`, coin flip, max 1–2/tick, bias from sign of `change24h`); analyst scores backlog + fresh (max 5, rotation `tick % len`), weighted `final = m*0.34 + l*0.22 + v*0.18 + t*0.26 + 14`, BUY ≥ 62 / WATCH ≥ 44 / SKIP else; tickets only for BUY ≥ 68 (max 2/cycle, one per symbol, 90s TTL); executor paper-fills spot (max 3 positions, $2.5–6.5k notional, 0.02–0.14% slippage, 0.04% fee) and profit-takes (18% chance if best `pnlPct > 0.15`).
4. **Perps** — analyst `createPerpTickets` sizes margin `max(500, (1500 + conf%*3500) * (1 − vol*0.35))`, leverage `clamp(11 − vol*9 + conf%*2, 2, 10)`, TP/SL drift 3–6% / 60% of drift, liq at `0.92/lev` distance; embeds EIP-712 `PerpOrderPayload` (domain `Trading Desk Perps v1`, chainId 42161). `markPerps` re-marks with leverage and auto-closes on liq/TP/SL (`closePerpPosition`, floor −98%). User-driven `executePerpTicket` (in `lib/store.tsx`) does optimistic `signed` → `signPerpOrder` → `executed` + `PerpPosition`, or revert to `proposed` + `execError` on failure.
5. **Jobs** — 6 `ScheduledJob`s (`lib/desk.ts:40`): scan/analysis/exec every 20s, rebalance every 5m (TP > +6% / SL < −4%), risk every 2m (flag worst < −2.5%), heartbeat every 60s. Pausable (`toggleJob`), manually runnable (`runJobNow` sets `nextRunAt = now`).
6. **Events** — capped at 400 newest-first (`MAX_EVENTS`); every phase pushes typed `AgentEvent`s (`market_scan|opportunity|analysis|signal|ticket|order|fill|portfolio|risk|heartbeat|job`) with human `title/detail` + optional JSON `payload`. All feeds/tables read from this single log.

## Caps and constants

| Constant | Value | Location |
|---|---|---|
| `TICK_MS` | 2000 | `lib/desk.ts:38` |
| `POLL_MS` (prices) | 15000 | `lib/store.tsx` |
| `MAX_EVENTS / OPPS / TRADES / TICKETS` | 400 / 60 / 200 / 80 | `lib/engine.ts:17` |
| `TICKET_TTL_MS` | 90_000 | `lib/engine.ts:21` |
| `CACHE_TTL_MS` (prices API) | 30_000 | `app/api/prices/route.ts:45` |
| `FETCH_TIMEOUT_MS` | 6_000 | `app/api/prices/route.ts:46` |
| `FRESH_MS / STALE_MS` (ticker) | 45s / 120s | `components/Ticker.tsx` |
| Base equity | $100,000 | `lib/desk.ts:133` |

## Styling

Tailwind v4 CSS-first: no `tailwind.config.js`; theme tokens (`ink-950…600, mint, flame, gold, sky, violet`) and keyframes (`pulse-dot, feed-in, ticker-scroll 40s, flash-green/red, scanline, shimmer, heartbeat-wave, glow-ring, spin-slow`) live in `app/globals.css`. `components/ui.tsx` exports the shared `Panel` wrapper.
