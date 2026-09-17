# AGENTS.md — trading-desk (`real-td`)

Real-time trading app (Next.js 15 + React 19, Tailwind v4). Work on branch `real-td`.
Direction: live price feeds, real wallet connections, real trade execution, LLM-assisted
scout/analyst. Market data is live (M2); execution is still paper — treat every step toward live
execution as security-critical. Details in `docs/`.

## Commands (Windows PowerShell 5.1)

- `npm.ps1` is blocked by execution policy — always invoke `& "npm.cmd" run <script>`.
- Scripts (`package.json`): `dev` / `build` / `start` / `typecheck` (`tsc --noEmit`). No tests, no linter.
- Verify with `& "npm.cmd" run typecheck` after code changes. `npm run build` only with no dev
  server running (both write `.next` — same for two dev servers: one server per checkout).
- Dev: `& "npm.cmd" run dev -- -p <port>` (3000-class ports are often busy; previews used 3512).
- Never commit: `node_modules/ .next/ *.tsbuildinfo dev.log .freebuff/` (all git-ignored).

## Architecture (wiring that filenames hide)

- `app/layout.tsx:13` — `WalletProvider` (outer) > `DeskProvider` (inner) > Sidebar/Header/main.
- `lib/store.tsx` — owns `DeskState`; boots client-only (`BootScreen` until mount, avoids hydration
  mismatch — do not move `createInitialState` into render). Boots with empty books, anchors on the
  first live poll. Two intervals: 2s `runTick` (`TICK_MS`, `lib/desk.ts:38`), 15s `GET /api/prices`
  poll (failures swallowed — last values hold, scout idles until the feed recovers).
- `lib/engine.ts:60` — `runTick` **mutates** the passed state: mark spot/perps from live-blended
  pairs → scout (fresh-live pairs only, `STALE_MS` 120s) → analyst → executor (same tick) → jobs.
  Caps: events 400, opps 60, trades 200, tickets 80. Ticket margin is wallet-equity-sized
  (`state.accountEquityUsd` via `lib/account.ts`, 0.5–2.5% of equity) — keep it that way; never
  size positions off anything but verified account value. No simulation remains (`tickMarket`,
  `seedHistory` deleted in M2).
- `lib/wallet.tsx` — display/balances only for spot; signing only for perp tickets via
  `signPerpOrder` (MetaMask `eth_signTypedData_v4`, Arbitrum One 42161), plus `sendTransaction`
  for M3 venue txs (MetaMask only, destination + chain enforced, demo rejected). `@solana/web3.js`
  is installed but nothing imports it — wallet uses injected providers + `POST /api/sol-balance` proxy.
- Live orders (M3, GMX v2) are additive and default-off (`DESK_LIVE_ORDERS_ENABLED=false`):
  `POST /api/orders/prepare` runs the M1 gates then builds the UNSIGNED multicall from
  `lib/server/venue/gmx.ts`; the server never signs or submits. Venue addresses are env-only
  (never hardcode — GMX routers change across upgrades); prepare `eth_getCode`-checks them
  and fails closed. Enablement drill in `docs/OPERATIONS.md`.
- Unified newest-first `AgentEvent` log (cap 400) feeds ActivityFeed/HistoryTable — the source of
  truth for "what happened".

## Security — hard rules

- Secrets stay server-side only: Route Handlers / `lib/server/*`, never `"use client"` modules, never
  logs, never git. `.env.example` is the template; real values go in git-ignored `.env.local`
  (`DESK_*`, see `docs/OPERATIONS.md`). `lib/server/trading.ts` throws if imported from client
  code — keep it that way. Add `NEXT_PUBLIC_` to nothing secret.
- Private keys / seed phrases must never enter app code, logs, payloads, or events. Only ever talk
  to injected providers (`window.phantom` / EIP-1193 / EIP-6963); never implement key handling.
- Never ask the user to paste keys/seeds, and never sign opaque or unexpected payloads — sign only
  the exact `PerpOrderPayload` the ticket displays (domain `Trading Desk Perps`, chainId 42161).
- `DESK_PERP_DOMAIN.verifyingContract` (`lib/engine.ts:24`) is currently `0x0…0` — placeholder.
  Nothing may go live against a zero/placeholder verifier; real settlement needs a real audited
  contract address + chainId check at sign time.
- Validate everything at trust boundaries: `POST /api/sol-balance` base58-check pattern is the
  model; apply the same skepticism to any new API input, LLM output, or upstream price payload
  (CoinGecko rate-limits hard; Binance fallback has no 24h changes — `app/api/prices/route.ts`).
- `fetch` to upstreams: keep the 6s abort timeout + `no-store` pattern; keep the 30s server price
  cache so clients share one upstream call.

## Trading safety — hard rules

- Default to paper: any real-execution path must be additive, behind an explicit per-action user
  confirmation, with size/leverage caps and a dry-run mode. Never convert the paper executor
  (`executorPhase`, `executePerpTicket`) to live orders implicitly.
- M6: paper fills, paper-ticket proposals/execution, and the demo wallet live only behind
  `NEXT_PUBLIC_DESK_PAPER_MODE=true` (local dev only, default off). Outside it the engine scores
  but fabricates nothing; live flow is prepare → wallet send → track (`LiveOrderPanel`).
- Known accounting quirk: `totalPnl` (`lib/desk.ts:123`) returns unrealized only (realized loop is a
  no-op). Use `realizedPnl` / `equity` / `winRate` (average-cost) for closed P&L — do not "fix" by
  changing numbers the UI already depends on without checking `KpiCards`.
- LLM output (scout/analyst, server-side advisory in M4) must be treated as untrusted input: validate shape,
  clamp scores via `clampScore`, keep the deterministic scorer as fallback, and never let model text
  reach signing/execution without passing the existing signal thresholds (BUY ≥ 62, ticket ≥ 68).
  `DESK_LLM_MODE=proposing` is refused by the routes — model output cannot create tickets.
- Minor verified quirks, don't "fix" blindly: `ActivityFeed showAgent` prop is a no-op; heartbeat
  job (`agent: "system"`) emits under the scout id.

## Workflow

- Read `docs/` before restructuring anything (`ARCHITECTURE`, `ENGINE`, `DATA_MODEL`, `API`, `WALLET`).
- Keep `README.md` + `docs/` accurate when behavior changes; they are verified against source.
- Commit on `real-td`, push to `origin/real-td`; inspect `git status` / `diff --stat` /
  `log --oneline -5` before committing, stage only intended files, never commit secrets.
