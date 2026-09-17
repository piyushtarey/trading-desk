# Engine — Simulation, Scoring, Jobs, Seed

All logic in `lib/engine.ts` (pure, mutates the passed `DeskState`), `lib/market.ts`, `lib/seed.ts`. Tick driver in `lib/store.tsx`, constants in `lib/desk.ts`.

## Tick (`runTick`, `lib/engine.ts:60`)

Every `TICK_MS` (2000ms) when `running`:

1. `tick++`, `now = Date.now()`.
2. `pairs = tickMarket(pairs)`; `markPositions`; `markPerps` (auto-closes hit perps).
3. `scoutPhase` → `analystPhase` → `executorPhase` (synchronous pipeline, same tick).
4. `runDueJobs`.

When paused, only `now` updates (clocks keep moving, market/agents freeze).

### Marking

- **Spot** (`markPositions`, `lib/engine.ts:78`): match pair by `base == symbol.split("/")[0]`; `mark = price`; `pnlPct = (price/entry − 1)*100*(long?1:−1)`; `pnl = notional*pct/100`.
- **Perps** (`markPerps`): same lookup; `movePct = (mark/entry − 1)*100*dir`; `pnlPct = move*leverage`; `pnl = margin*pct/100`; liq/TP/SL hits → `closePerpPosition` (see below).

## Scout (`scoutPhase`, `lib/engine.ts:91`)

- Sets `scout.state = scanning`, task `Scanning N pairs across Solana + EVM`, heartbeat + cycle bump.
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

- Candidates: BUY analyses with `confidence ≥ 68`, no open `proposed` ticket for the same symbol, max 2 per cycle.
- Sizing: `sizeUsd = max(500, round((1500 + confFraction*3500) * (1 − vol*0.35)))`; `leverage = round(clamp(11 − vol*9 + confFraction*2, 2, 10))`; `notional = size*lev`.
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

## Seed history (`lib/seed.ts`)

- Deterministic PRNG `mulberry32(1337)`; walks 48 hourly steps (`h = 47..0`), 0–3 opps/hour on random `PAIR_SEEDS`.
- Same scoring formula as live (thresholds BUY ≥ 68 / WATCH ≥ 44 here); BUYs roll tickets (50%) and spot buys (70%, sells 65% after 5–60m with `move = (rand−0.42)*9%`); occasional job/risk/heartbeat events.
- Fresh (<2m) tickets weighted proposed/executed/cancelled/expired; older only executed/cancelled/expired.
- Derives spot `positions` (last buy per symbol without later sell, marked from current pairs) and `perpPositions` (executed tickets; still-open 85% if <30m else 30%; closed with exit drift + via take-profit/manual/stop-loss/liquidation + `fill` event).
- Caps: events ≤ 400, analyses ≤ 200, trades ≤ 200, opps ≤ 60, tickets ≤ 80, perps ≤ 40; all newest-first.

## Market (`lib/market.ts`)

- `PAIR_SEEDS`: SOL 148.32, JUP/SOL 0.86, BONK/SOL 0.0000216, WIF 1.94, JTO 2.61, ETH 3120.5, WBTC/ETH 19.8, ARB 0.74, OP 1.62, LINK 14.27, UNI 7.83, AAVE 142.6 (with per-seed vol/liq).
- `createMarket`: spark 24 pts (sine + random walk), `change24h = (rand−0.45)*8`, `volume = liq*(0.4+rand*0.8)`, `liveLastAt = null`.
- `tickMarket`: global shove `(rand−0.5)*0.002`, per-pair `vol = 0.0012 + volatility*0.004`, 3% shock ±1%, spark cap 48, `change24h` decay + return reaction, volume/liquidity drift.
