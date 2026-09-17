# Frontend — Routes & Components

## Routes

| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | Dashboard: KPI strip, agent board, activity + schedule split, open positions |
| `/agents` | `app/agents/page.tsx` | 3-agent overview grid (Scout 🔭 / Analyst 🧠 / Executor ⚡), duties, cycles/tasks/heartbeats, event counts, links to detail |
| `/agents/[id]` | `app/agents/[id]/page.tsx` | Detail for `scout|analyst|executor` (Next 15 async `params`); invalid id → "unknown agent" + back link |
| `/perps` | `app/perps/page.tsx` | Perp ticket book + open/closed perp positions; MetaMask-gated execution |
| `/history` | `app/history/page.tsx` | Combined timeline with agent shortcut links + `HistoryTable pageSize=50` |
| `GET /api/prices` | `app/api/prices/route.ts` | Live feed (see `API.md`) |
| `POST /api/sol-balance` | `app/api/sol-balance/route.ts` | SOL balance proxy (see `API.md`) |

Root layout `app/layout.tsx:13` wraps everything in `WalletProvider > DeskProvider` with `Sidebar` + `Header` + scrollable `main`.

## Pages in detail

### Dashboard (`app/page.tsx`, `"use client"`)

- `useDesk()` → `{ state, toggleRunning }`.
- Header: tick interval (`TICK_MS/1000`s), `tick #`, clock `fmtTime(now)`, Pause/Resume button.
- `Panel`s: `KpiCards` → `AgentBoard` → `ActivityFeed (limit=50)` + `ScheduleList` (`xl:grid-cols-3`) → `PositionsTable`.

### Agents overview (`app/agents/page.tsx`)

- Static `AGENTS` const: id, name, role, icon, accent/border, desc, 3 duties each.
- Per agent: `state.agents[id]` (`cycle, tasksDone, heartbeatAt`), `state.events.filter(agent).length`.
- Card links to `/agents/${id}`.

### Agent detail (`app/agents/[id]/page.tsx`)

- `META` record + `AGENT_ORDER = [scout, analyst, executor]` nav.
- Derived: `runtime`, `agentEvents`, `signals = analyses.slice(0,8)`, `fills = trades.slice(0,8)`.
- Sections: 4× `Stat` (State/Cycles/Tasks done/Events logged) → Current task (`currentTask, lastOutput, heartbeat`) + Recent signal scores (`SignalList`) → Recent fills (`FillList`) + This agent's stream (`ActivityFeed limit=30 showAgent=false`) → Full event history (`HistoryTable agent=agentId pageSize=25`).
- `SignalList`: BUY (green) / WATCH (gold) / SKIP (grey) chip, confidence, breakdown `M/L/V/T/Σ`, note, time.
- `FillList`: side chip, qty `toPrecision(4)`, price `toPrecision(6)`, notional, slip `toFixed(3)%`, time.

### Perps (`app/perps/page.tsx`, `"use client"`)

- Hooks: `useDesk()` (`state, executePerpTicket, cancelTicket, closePerp, execError, clearExecError`), `useWallet()`.
- Derived: `metamaskReady`, `open/closed` perp positions, `tickets.slice(0,15)`, `awaiting` count (`proposed && expiresAt > now`), `totalMargin/totalUPnl/totalNotional`.
- KPIs: Open perps, margin at risk, open P&L (mint/flame), awaiting execution.
- Ticket Book columns: Side / Market / Lev / Entry / Margin→Notional / Liq / TP / SL / Conf / Expires / Action. Row is `signable = proposed && !expired && metamaskReady`; button label adapts: `Execute with MetaMask | Execute (paper sign) | Connect & sign`; else `StatusChip` (signed sky, executed mint, cancelled grey, expired gold).
- Open Perp columns: Side / Market / Lev / Qty / Entry / Mark / Margin / uPnL / Action (Close). Closed table adds Closed-via `ViaChip` (take-profit mint, stop-loss gold, liquidation flame, manual grey) + realized P&L + closed-at.
- Paper-venue warning banner + `execError` banner with dismiss.

### History (`app/history/page.tsx`)

- Title + 3 agent filter links + `Panel Combined timeline > HistoryTable pageSize=50`.

## Components (`components/`)

| Component | Props | Reads | Renders |
|---|---|---|---|
| `AgentBoard.tsx` | — | `state.agents`, events per agent | 3 linked cards: icon (analyst spins when analyzing), running pulse dot, `STATE_LABEL` (Ready/Scanning/Scoring/Routing/Waiting or Paused), task + scanline, heartbeat bars + time, cycle/tasks/lastOutput, last event; `→` separators on md+ |
| `ActivityFeed.tsx` | `limit=40, showAgent=true` | `state.events.slice(0,limit)` | Rows: agent chip (scout sky/analyst violet/executor mint), title, time, detail; newest row animates when running. Note: `showAgent` is currently a no-op (`{showAgent && null}`) |
| `HistoryTable.tsx` | `agent?, pageSize=50` | `state.events` via `useMemo` filter | Type pills (`all/opportunity/signal/ticket/order/fill/job/risk/heartbeat`), search box, table Time/Agent?/Event/Type/Detail, click-to-expand JSON payload, pagination footer |
| `KpiCards.tsx` | — | positions + trades via `realizedPnl`, `winRate` | 4 KPIs: Total P&L (`useCountUp` + `useFlash` green/red, sub realized/open), Win rate, Opportunities (+pending), Trades executed (+closed/open) |
| `PositionsTable.tsx` | — | `state.positions` | Empty dashed state or table Symbol/Chain (SOL violet/EVM gold)/Entry/Mark/Size/P&L/P&L%; adaptive price formatting |
| `ScheduleList.tsx` | — | `state.jobs`, `useNow(250ms)` | Per-job rows: agent chip, `▶ now` + pause/resume, progress bar (shimmer or paused grey), `every X · N runs`, paused/next-in countdown |
| `Ticker.tsx` | — | `state.pairs`, `marketSource/lastLiveAt` | Marquee (duplicated array, 40s scroll): per-pair arrow + adaptive price + 24h%; `FeedBadge`: `LIVE·BINANCE/LIVE·COINGECKO` (<45s, mint), `STALE` (<120s, gold), else `SIM` (grey) |
| `Sidebar.tsx` | — | `usePathname()`, `running`, events, tickets | Nav `/ ▤, /agents ◇, /perps ⚡, /history ≣`; active = exact for `/` else `startsWith`; badges: history = events count, perps = unexpired proposed count; footer running dot + `mockup v0.1` |
| `Header.tsx` | — | — | `<Ticker/>` + `<WalletButton/>` bar |
| `WalletButton.tsx` | — | `useWallet()` + `useDesk()` (SOL/ETH price for USD) | Connect → dropdown (Phantom/MetaMask installed state + Demo); connected `Notch`: pill + dropdown (address+copy, balance+USD, network, refresh/explorer/disconnect); error/fallback messages |
| `ui.tsx` | `Panel({title, action?, children, className?, bodyClassName?})` | — | `section rounded-xl border bg-ink-900/60` + optional uppercase header |

## Formatting (`lib/format.ts`)

`fmtUsd(n, {sign, compact})` (compact K/M/B ≥1000; 2dp ≥100, 2dp ≥1, else 4dp), `fmtPct(n, digits=2)` (+ when >0), `fmtQty` (locale ≥1000, 4dp ≥1, else 6dp), `fmtTime` (locale time, 24h), `fmtDateTime`, `fmtDuration` (s/m/h/d), `fmtInterval` (1m/Xm/Xs), `shortAddr` (first5…last4 when >12 chars).
