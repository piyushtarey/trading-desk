# Data Model

All types live in `lib/types.ts`. State container in `lib/desk.ts:15`.

## Core entities

### `MarketPair` (`lib/types.ts:9`)

`{ id, symbol (BASE/QUOTE), base, quote, chain (solana|evm), price, prevPrice, change24h (%), volume24h, liquidity, volatility (0..1), spark[] (last N prices), liveLastAt (ms|null) }`.

- IDs: `sol-<base>` / `evm-<base>` (e.g. `sol-sol`, `evm-eth`).
- 12 pairs from `PAIR_SEEDS` (`lib/market.ts`): SOL/USDC, JUP/SOL, BONK/SOL, WIF/USDC, JTO/USDC (solana); ETH/USDC, WBTC/ETH, ARB/USDC, OP/USDC, LINK/USDC, UNI/USDC, AAVE/USDC (evm).

### `Opportunity` (`lib/types.ts:26`)

Scout output: `{ id, pairId, symbol, chain, foundAt, momentum (0..1), liquidityScore (0..1), volRisk (0..1), bias (long|short from sign of change24h), status (pending|analyzed|executed|skipped) }`. Newest-first, capped at 60.

### `ScoreBreakdown` + `Analysis` (`lib/types.ts:112`, `120`)

Analyst output: `Analysis { id, opportunityId, symbol, chain, signal (BUY|WATCH|SKIP), confidence (0..100), breakdown {momentum, liquidity, volatility, trend, final}, note, at }`. Newest-first, capped at 200 (seed caps at 200).

### Spot: `Trade` + `Position` (`lib/types.ts:132`, `146`)

- `Trade { id, symbol, chain, side (buy|sell), qty, price, slippage (%), fee, notional, at, sourceOpportunityId? }`. Newest-first, capped at 200.
- `Position { id, symbol, chain, side (long|short), entryPrice, markPrice, notionalUsd, qty, openedAt, pnlPct, pnl }`. Max ~3 open (executor gate); re-marked every tick.

### Perps: `PerpTicket` + `PerpPosition` (`lib/types.ts:40`, `63`, `88`)

- `PerpTicketStatus = proposed|signed|executed|cancelled|expired`.
- `PerpTicket { id, analysisId, opportunityId, symbol, chain, side, entryPrice, sizeUsd (margin), leverage (2..10), notionalUsd, liqPrice, takeProfit, stopLoss, confidence, breakdown, note, status, createdAt, expiresAt (+90s), equityUsd? (wallet equity the margin was sized from, null when unknown), signedBy?, signature?, order?: PerpOrderPayload }`. Newest-first, capped at 80.
- `PerpOrderPayload`: EIP-712 payload — `domain {name: Trading Desk Perps, version: 1, chainId: 42161, verifyingContract: 0x0…0}`, `primaryType: PerpOrder`, 12 typed fields (symbol/side/qty/entryPrice/leverage/notionalUsd/liqPrice/takeProfit/stopLoss as strings, `expiresAt: uint256` seconds, `nonce: string`).
- `PerpPosition { id, ticketId, symbol, chain, side, qty, leverage, entryPrice, markPrice, marginUsd, notionalUsd, liqPrice, takeProfit, stopLoss, pnl (leveraged USD), pnlPct (% on margin), openedAt, status (open|closed), closedVia? (take-profit|stop-loss|liquidation|manual), closedAt?, realizedPnl? }`.

### `ScheduledJob` (`lib/types.ts:160`)

`{ id, kind (scan|analysis|exec|rebalance|risk|heartbeat — the handler key, not the id), builtIn, agent (scout|analyst|executor|system), name, description, intervalMs (10s–24h enforced), nextRunAt, lastRunAt|null, runCount, paused }`. Six built-ins from `createJobs`; custom jobs append with `builtIn: false`. Overrides + customs persist in `localStorage` (`tradingdesk.jobs.v1`); timers restart on boot (`nextRunAt = now + interval`) so reloads never fire a stale burst.

### `AgentEvent` (`lib/types.ts:172`, `185`)

Single unified log: `{ id, agent (scout|analyst|executor), type, title, detail, payload?, at }`. Types: `market_scan|opportunity|analysis|signal|ticket|order|fill|portfolio|risk|heartbeat|job`. Newest-first, capped at 400.

**Note:** jobs with `agent: "system"` (heartbeat) still emit events attributed to `scout` (heartbeat event uses the scout agent id).

### `AgentInfo` / runtime (`lib/types.ts:195`, `lib/desk.ts:25`)

Runtime slice per agent: `{ state, currentTask, lastOutput, heartbeatAt, cycle, tasksDone }` (+ static `META` name/role/icon/accent in pages/components). States: `idle|scanning|analyzing|executing|waiting`.

### `DeskState` (`lib/desk.ts:15`)

```ts
{ running, tick, now, pairs, opportunities, analyses, positions, trades,
  events, agents, jobs, startedAt, marketSource (sim|coingecko|binance),
  lastLiveAt|null, tickets, perpPositions, accountEquityUsd|null }
```

`accountEquityUsd` is the connected-wallet USD value (`lib/account.ts`: native
balance × desk live price, demo at paper value), refreshed every tick — the
input to ticket margin sizing. Null when disconnected/loading.

## Lifecycles

- **Opportunity**: `pending` → `analyzed` (BUY) / `skipped` (SKIP) / stays `pending` (WATCH) → `executed` (spot fill consumes the BUY).
- **Ticket**: `proposed` → `signed` (optimistic, during wallet signing) → `executed` (position opens) / `cancelled` (user) / `expired` (TTL passes; sweeper marks them).
- **Perp position**: `open` → `closed` via `take-profit | stop-loss | liquidation | manual`.
- **Spot position**: opened by executor buy (merge-averages if symbol exists), removed on sell/rebalance close.

## Accounting (`lib/desk.ts:123`)

- `realizedPnl(trades)`: average-cost FIFO per symbol, chronological, sells contribute `(price − avg)*qty − fee`.
- `winRate(trades)`: sells above avg cost / closed sells × 100, else 0.
- `equity(state)`: `100_000 + Σ position.pnl + realizedPnl(trades)`.
- `totalPnl(positions, trades)`: **currently returns unrealized only** — the realized loop is a no-op (`t.side === "sell" ? 0 : 0`). Use `realizedPnl`/`equity` for closed P&L.
- `clampScore(n)`: `clamp(round(n), 0, 100)`.
