# Operations — Safety Rails (M1)

How to run this desk without losing money to your own tooling. Read this before
touching caps, dry-run, or the kill switch.

## Mental model

```
Client intent (perps confirm screen, M3)
  -> POST /api/orders/intent
    -> shape validation (lib/risk.ts)
    -> kill-switch check (423 when halted — new risk blocked, positions untouched)
    -> caps check (422 with code NOTIONAL_CAP | LEVERAGE_CAP | POSITION_CAP | DAILY_LOSS_LIMIT)
    -> audit (every step recorded)
    -> dry-run echo (default) | 501 venue-adapter-not-configured (only if DESK_DRY_RUN=false)
```

Every rejection is audited with its reason. The client banner (`HaltBanner`, polled
every 15s from `GET /api/trading/status`) shows `DRY-RUN` / `ARMED` / `TRADING HALTED`.

## Environment

Copy `.env.example` to `.env.local` (git-ignored — verify with `git status` before
every commit). All `DESK_*` vars are server-only.

| Var | Default | Meaning |
|---|---|---|
| `DESK_TRADING_HALTED` | `false` | `"true"` boots halted (fail closed). Use when restarting into uncertainty. |
| `DESK_DRY_RUN` | `true` | Anything except `"false"` = validate + audit, never submit. Do not set `false` until the M3 venue adapter exists — the intent route fails closed (501) without one. |
| `DESK_MAX_NOTIONAL_PER_TRADE_USD` | `1000` | Per-order margin × leverage ceiling. |
| `DESK_MAX_LEVERAGE` | `5` | Per-order leverage ceiling (absolute code ceiling 25x regardless). |
| `DESK_MAX_OPEN_POSITIONS` | `3` | New risk blocked at the cap. |
| `DESK_MAX_DAILY_LOSS_USD` | `500` | New risk blocked once day realized P&L ≤ −cap. Resets implicitly as day P&L is caller-supplied context until M3 derives it from the venue. |
| `DESK_AUDIT_LOG_PATH` | unset | JSONL audit file (e.g. `./trading-audit.jsonl`). Stdout always carries structured `desk-audit` lines regardless. |

Invalid env values fall back to defaults (see `lib/server/trading.ts`) — misconfiguration fails safe, but check stdout on boot if caps look wrong.

## Kill-switch procedure

1. **Halt**: red banner → `Resume`/`Halt` buttons call `POST /api/trading/halt`; or `curl -X POST localhost:3000/api/trading/halt -H 'Content-Type: application/json' -d '{"halted":true,"reason":"..."}'`.
2. Halting blocks **new** risk only. It never closes positions — closing into a halt can realize losses or fight liquidations; close deliberately from `/perps`.
3. **Resume** only after the cause is understood and recorded in the halt reason / audit.
4. Halt state is **in-memory per server instance**. After a restart it resets to `DESK_TRADING_HALTED`. Do not run multiple instances yet (see below).

## Audit log

`recordAudit` (`lib/server/trading.ts`) writes to three sinks: in-memory ring (last
500, newest-first), structured stdout (`{"scope":"desk-audit",...}`), and JSONL file
when `DESK_AUDIT_LOG_PATH` is set. Kinds: `intent_received | intent_validated |
intent_rejected | halt | resume`. There is deliberately **no `GET /api/audit`** yet —
with no auth in the app, activity history is read from logs/files, not the browser.
Never log secrets, keys, or full signatures (truncate identifiers).

## Pre-public-exposure checklist (blocking)

- [ ] Auth-gate `POST /api/trading/halt` (anyone who can reach it can halt — or resume — your desk).
- [ ] Reconsider all unauthenticated mutating routes (`/api/orders/*` included).
- [ ] Single instance only, or move halt state + audit ring to shared storage (Redis/Postgres).
- [ ] `DESK_TRADING_HALTED=true` on boot until the instance is verified healthy.
- [ ] `git status` clean of `.env.local` before every push (git-ignored, but verify).

## M3 — live venue orders (GMX v2)

Disabled by default (`DESK_LIVE_ORDERS_ENABLED=false`). The flow is deliberately
split so no single step can move funds alone:

```
perps LiveOrderPanel -> POST /api/orders/prepare (M1 gates + venue quote)
  -> review decode -> MetaMask eth_sendTransaction (wallet enforces chain)
  -> POST /api/orders/track (receipt: pending | success | reverted)
```

The server never holds keys, never signs, never submits. "Success" on track means
the *creation* landed — GMX keepers still execute asynchronously (seconds/minutes),
so creation is never treated as a fill. Confirm fills in the GMX app / Arbiscan.

### Enabling (testnet first, always)

1. Copy `.env.example` M3 section into `.env.local`. Start with
   `DESK_GMX_CHAIN_ID=421614` (Arbitrum Sepolia) and the Sepolia addresses from
   https://docs.gmx.io/docs/api/contracts/addresses — NOT mainnet.
2. Fund the test wallet with Sepolia ETH (execution fee + gas) and test USDC.
3. Restart the server. `GET /api/orders/markets` should list your allowlist;
   anything misconfigured returns 503 with the reason (fail closed).
4. Drill: prepare a dust-size order, verify the decode (market, side, notional,
   acceptable price, destination = ExchangeRouter), send, track to success, then
   confirm keeper execution in the GMX testnet app. Check the audit log for
   `intent_received → intent_validated → prepared`.
5. Only then repeat for mainnet (`42161`), starting at minimum size with tight caps.

### Address verification (required — do not skip)

- Router-family contracts change across GMX upgrades: two GMX-affiliated sources
  already disagreed on the Arbitrum ExchangeRouter during M3 research. Treat every
  address as guilty until proven innocent.
- Verify each `DESK_GMX_*` address on Arbiscan (contract name tag + verified source)
  AND against https://docs.gmx.io/docs/api/contracts/addresses (pinned commit).
- The prepare endpoint `eth_getCode`-checks router/vault/market on every call and
  refuses to build against dead addresses — but that only proves *something* is
  deployed there, not that it is the contract you expect.
- Re-verify after any GMX upgrade announcement
  (https://docs.gmx.io/docs/api/updates-support/).

### GMX model notes (affect the UI copy, don't "simplify" them away)

- WNT execution fee rides in `msg.value`; excess is refunded to the order account.
  Default `0.0008 ETH` overpays slightly on purpose — underpaying means keepers
  never pick the order up.
- USDC collateral needs a Router approval first (`sendTokens` pulls it).
- Market orders cancel (refund) if `acceptablePrice` can't be met — slippage setting
  (`DESK_GMX_SLIPPAGE_BPS`, default 50 = 0.5%) is a real economic parameter.
- M3 covers MarketIncrease only, USDC collateral, no swaps. Position closes
  (MarketDecrease), TP/SL, and Reader-based position reconciliation are M5.

## M5 — exits + on-chain position visibility

- `GET /api/positions?account=` reads open positions from the GMX Subsquid
  indexer (Arbitrum One only; 6s timeout). `account_eq` is case-sensitive —
  the server checksum-normalizes first. Indexer lags chain by seconds.
- `POST /api/orders/prepare` with `kind: "decrease"` + `decrease:
  {symbol, side, sizeDeltaUsd, collateralDeltaUsd}` builds the close multicall
  (`sendWnt` + `createOrder(MarketDecrease)`, no collateral transfer, no approvals).
  Closes pass validation + kill switch but bypass caps (exits must never be blocked).
- When the indexer is readable, a close larger than the on-chain position is
  rejected (422); unreadable telemetry only warns. Full closes from the panel's
  Close button use exact on-chain values, so this rarely triggers.
- The panel passes the venue-derived open-position count into increase-prepare
  context (day P&L is still caller-asserted until derived on-chain).
- Limit/stop (TP/SL) trigger orders are not implemented yet — exits are full
  market closes; manage TP/SL in the GMX app until then.

## M6 — paper mode (default OFF)

`NEXT_PUBLIC_DESK_PAPER_MODE=true` restores legacy paper behavior for local dev
only: engine paper fills + rebalance, analyst paper-ticket proposals (fake EIP-712
payloads), paper ticket execution, demo wallet + silent demo fallbacks. Default
(off) the engine scores live data but fabricates nothing — KPIs read 0, the
ticket book stays empty, demo is hidden, and missing extensions fail loudly.
Never enable outside local dev: the numbers are fake even when labeled PAPER.

## M4 — LLM scout/analyst (server-side, advisory only)

Model output is untrusted input: routes compute the deterministic score first,
then optionally call the model, validate strictly, and log agreement.
`DESK_LLM_MODE=proposing` is refused (403) — nothing creates tickets from model
output yet, by design.

### Modes

| Mode | Behavior |
|---|---|
| `off` (default) | Routes 403. No key needed, no calls possible. |
| `shadow` | Runs the model per explicit request, audits agreement (`llm_run`), drops violations (`llm_rejected`). UI stays deterministic. |
| `advisory` | Shadow + `/agents/analyst` shows the model as a labeled second opinion. |
| `proposing` | Refused. Reserved until the exit criteria below are met. |

### Enabling

1. Set `DESK_LLM_PROVIDER=openai|anthropic`, `DESK_LLM_API_KEY`, optionally
   `DESK_LLM_MODEL` / `DESK_LLM_API_URL` (proxy must speak the provider's API).
2. Start with `DESK_LLM_MODE=shadow`. `GET /api/llm/status` should report
   `configured: true`. Exercise `POST /api/llm/scout` + `analyst` and watch the
   audit log for `llm_run` (overlap, signal-match, latency) vs `llm_rejected`.
3. Promote to `advisory` only when rejects are rare and agreement is sane over
   days of varied markets — then the analyst page shows the panel.
4. Budgets are per call: `DESK_LLM_TIMEOUT_MS` (default 25s), `DESK_LLM_MAX_TOKENS`
   (default 800), one retry on 429/5xx, pairs capped at 20, scout candidates at 5.
   There are no background calls — every call is an explicit user action.

### Rules that don't change with modes

- Prompts are versioned (`scout-v1`/`analyst-v1`, echoed in responses + audit).
  Bump the version on any prompt edit so agreement history stays comparable.
- Model `reason` strings are display-only, sanitized (control chars stripped,
  140 chars), never interpolated into orders, tickets, or signing payloads.
- Thresholds still dispose: BUY ≥ 62, ticket ≥ 68 — the model cannot lower them.
- **Cost warning**: each call spends your LLM budget. Auth-gate `/api/llm/*`
  before exposing this instance (same checklist as halt/orders).

### Proposing exit criteria (all required, then implement — not before)

- [ ] Weeks of shadow logs: high signal-match, low score-delta, near-zero rejects.
- [ ] Adversarial review of validator + prompt-injection posture.
- [ ] Explicit per-ticket user confirmation path for model-proposed tickets.
- [ ] Cap model-proposed tickets separately (count + notional), kill-switchable.

## Jobs tab (`/jobs`)

- Every job's interval is editable inline (`15s`/`2m`/`1h` syntax, 10s floor,
  24h ceiling); changing it resets that job's next run. Rename, pause/resume,
  run-now, and delete (two-step, built-ins included) all audit to the event log.
- New jobs pick one of the 6 fixed handler kinds — behavior stays reviewable;
  there are no custom code bodies.
- Overrides + custom jobs persist in `localStorage`; corrupt payloads are
  discarded, timers restart on boot.
- ⚠ `rebalance` **closes positions** (TP > +6% / SL < −4% in paper mode).
  Pausing, slowing, or deleting it changes risk posture — the UI warns, and the
  delete audit notes when a handler kind is left with zero jobs. Sub-20s
  intervals will flood the 400-event ring; the caps hold, but history gets noisy.

## Trying the rails (dry-run, no venue needed)

```powershell
# Status / caps
curl http://localhost:3000/api/trading/status

# Valid intent (dry-run echo)
curl -X POST http://localhost:3000/api/orders/intent `
  -H "Content-Type: application/json" `
  -d '{"intent":{"symbol":"SOL/USDC","side":"long","sizeUsd":100,"leverage":3}}'

# Cap rejection (notional 100*10=1000 ok; size 500*10=5000 rejects)
curl -X POST http://localhost:3000/api/orders/intent `
  -H "Content-Type: application/json" `
  -d '{"intent":{"symbol":"SOL/USDC","side":"long","sizeUsd":500,"leverage":10}}'

# Halt, then watch the same intent come back 423
curl -X POST http://localhost:3000/api/trading/halt `
  -H "Content-Type: application/json" `
  -d '{"halted":true,"reason":"drill"}'
```
