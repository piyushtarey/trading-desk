# Engine — Simulation, Scoring, Jobs, Seed

All logic in `lib/engine.ts` (pure, mutates the passed `DeskState`), `lib/market.ts`, `lib/seed.ts`. Tick driver in `lib/store.tsx`, constants in `lib/desk.ts`.

## Tick (`runTick`, `lib/engine.ts:60`)

Every `TICK_MS` (2000ms) when `running`:

1. `tick++`, `now = Date.now()`.
2. `markPositions` / `markPerps` on the current live-blended pairs (prices move
   only via `applyLivePrices` blends from the 15s poll; stale pairs hold last values).
3. `scoutPhase` → `analystPhase` → `executorPhase` (synchronous pipeline, same tick).
4. `runDueJobs`.

When paused, only `now` updates (clocks keep moving, market/agents freeze).

### Marking

- **Spot** (`markPositions`, `lib/engine.ts:78`): match pair by `base == symbol.split("/")[0]`; `mark = price`; `pnlPct = (price/entry − 1)*100*(long?1:−1)`; `pnl = notional*pct/100`.
- **Perps** (`markPerps`): same lookup; `movePct = (mark/entry − 1)*100*dir`; `pnlPct = move*leverage`; `pnl = margin*pct/100`; liq/TP/SL hits → `closePerpPosition` (see below).

## Scout (`scoutPhase`, `lib/engine.ts:91`)

- Sets `scout.state = scanning`, heartbeat + cycle bump.
- **Freshness gate**: only pairs blended within `STALE_MS` (120s, `lib/engine.ts`)
  are tradeable. With none fresh, the scout idles (`Waiting for live feed`) and
  returns no opportunities — reference values are never scored.
- `maxNew = 1 + (35% chance of +1)`.
- Shuffles pairs; `heat = |change24h|/8 + volatility*0.5`; if `heat > 0.75 && Math.random() < 0.5` → new `Opportunity`:
  - `momentum = clamp(|change|/8)`, `liquidityScore = clamp(liquidity/60M)`, `volRisk = volatility`, `bias = change ≥ 0 ? long : short`, `status = pending`.
- Emits `opportunity` event per find; `tasksDone += found`; `lastOutput` summarizes; back to `idle`.

## Analyst (`analystPhase`)

- Sets `analyzing`; backlog = pending opps excluding fresh, rotated by `tick % len`; queue = fresh + rotated, sliced to 5.
- Per opp:
  - `momentum = clamp(opp.momentum*100*1.1 + (rand−0.3)*15)`
  - `liquidity = clamp(opp.liquidityScore*100*1.05 + (rand−0.35)*12)`
  - `volatility = clamp(60 − volRisk*55 + (rand−0.4)*10)` (inverse: calmer = higher score)
  - `trend = clamp(|change24h|*9 + (rand−0.3)*10)`
  - `final = clampScore(m*0.34 + l*0.22 + v*0.18 + t*0.26 + 14)`
  - Signal: `BUY ≥ 62`, `WATCH ≥ 44`, else `SKIP`; `confidence = clamp(final ± 4)`; human `note`.
  - Status: BUY → `analyzed`, SKIP → `skipped`, WATCH stays `pending`.
  - Unshift `Analysis` + emit `signal`/`analysis` event.
- Then `createPerpTickets` + `expireStaleTickets`; bump cycle/tasks/lastOutput.

### Perp ticket creation

- Candidates: BUY analyses with `confidence ≥ 68`, no open `proposed` ticket for the same symbol, max 2 per cycle. (Paper-mode harness only — no tickets are minted by default in M6.)
- Sizing: margin is a fraction of connected-wallet equity (`state.accountEquityUsd`, refreshed every tick): `risk = 0.5% + confidence×2.0%`, `margin = equity × risk × (1 − vol×0.35)`, clamped to `$50 min / 10% of equity max` (`lib/account.ts`). Disconnected wallets fall back to the legacy fixed sizer (`$500 min`). The equity snapshot rides on the ticket (`equityUsd`) and the ticket-book margin cell shows what it was sized off.
- Leverage: `leverage = round(clamp(11 − vol*9 + confFraction*2, 2, 10))`; `notional = size*lev`.
- Levels: `drift = 3–6%` (`expPct(0.045, 0.03)`); entry = live pair price; TP/SL = entry ± drift / ± drift*0.6 (sign by side); liq distance `0.92/lev` against the side.
- Order: EIP-712 `PerpOrderPayload` — domain `Trading Desk Perps / 1 / 42161 / 0x0…0`, qty `(size*lev/entry).toFixed(6)`, prices `toPrecision(8)`, `expiresAt` seconds, random hex `nonce`.
- TTL 90s (`TICKET_TTL_MS`, `lib/engine.ts:21`); emits `ticket` event per creation.

### Expiry sweeper

`proposed && expiresAt <= now` → `expired` + executor `ticket` event.

### Perp close (`closePerpPosition`)

- Exit = live pair price else stored mark; `pnlPct = max(move*lev, −98)` (floor); `realized = margin*pct/100`; `status = closed`, `closedVia/closedAt`, executor `fill` event.

## Executor (`executorPhase`)

- Sets `executing`.
- **Buys**: BUY analyses, `maxNew = max(0, 3 − positions.length)`; per buy: `notional = 2500 + rand*4000`, `qty = notional/price`, `slippage = 0.02 + rand*0.12%`, `fee = notional*0.0004`, `fill = price*(1+slip%)`; unshift buy `Trade`; opp → `executed`; merge-average into existing symbol position or create `long` position; emit `order` event; `tasksDone++`.
- **Profit-take**: 18% chance when positions exist — best `pnlPct` position closes if `> 0.15` via `closePosition` (sell slippage 0.02–0.12%, `fill = mark*(1−slip)`, sell `Trade`, remove position, `fill` event).
- Bump cycle/lastOutput.

## Jobs (`runDueJobs`, 6 jobs from `createJobs`, `lib/desk.ts:40`)

| ID | Agent | Name | Every | Notes |
|---|---|---|---|---|
| `job-scan` | scout | Market scan | 20s | Emits `job` event with opp count |
| `job-analysis` | analyst | Signal refresh | 20s | Emits `job` event with analysis count |
| `job-exec` | executor | Signal sweep | 20s | Emits `job` event with trade count |
| `job-rebalance` | executor | Portfolio rebalance | 5m | Closes positions `pnlPct > +6` (take-profit) or `< −4` (stop-loss) |
| `job-risk` | analyst | Risk sweep | 2m (first due +90s) | Flags worst position `< −2.5` as `risk`, else `clean` |
| `job-heartbeat` | system | Health heartbeat | 60s | Refreshes all heartbeats; emits scout `heartbeat` event |

Due job: `lastRunAt = now`, `runCount++`, `nextRunAt = now + interval`. Paused jobs are skipped (`toggleJob` flips `paused`; resuming sets `nextRunAt = now + 5s`). `runJobNow` forces `nextRunAt = now`.

## Seed history (removed in M2)

`lib/seed.ts` (deterministic 48h fake history, mulberry32 seed `1337`) was deleted.
The desk boots with empty books and anchors on the first live poll — an empty desk
before live data is honest. No seeded trades, tickets, or events exist anymore.

## Market (`lib/market.ts`)

- `PAIR_SEEDS`: the 12-pair universe (metadata + reference prices + static
  liquidity): SOL 148.32, JUP/SOL 0.86, BONK/SOL 0.0000216, WIF 1.94, JTO 2.61,
  ETH 3120.5, WBTC/ETH 19.8, ARB 0.74, OP 1.62, LINK 14.27, UNI 7.83, AAVE 142.6.
- `createMarket()`: bootstrap shells (reference price, `change24h: 0`,
  single-point spark, `liveLastAt: null`). First `applyLivePrices` blend replaces
  every display value; the ticker badge shows SIM until then.
- Price movement comes exclusively from live blends (`lib/prices.ts`); the old
  `tickMarket` random-walk was deleted. Uncovered/stale pairs hold last values.
