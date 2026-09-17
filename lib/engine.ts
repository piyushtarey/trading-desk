import type {
  AgentEvent,
  AgentId,
  AgentEventType,
  Analysis,
  JobKind,
  MarketPair,
  Opportunity,
  PerpPosition,
  PerpTicket,
  Position,
  ScheduledJob,
  Trade,
} from "./types";
import { clamp, uid } from "./rng";
import { clampScore, type DeskState } from "./desk";
import { sizeMarginFromEquity } from "./account";

const MAX_EVENTS = 400;
const MAX_OPPS = 60;
const MAX_TRADES = 200;
const MAX_TICKETS = 80;
const TICKET_TTL_MS = 90_000;
/** Pairs older than this since the last live blend are ignored by the scout. */
export const STALE_MS = 120_000;
/**
 * M6: paper fills and paper ticket proposals exist only as a local-dev
 * harness (NEXT_PUBLIC_DESK_PAPER_MODE=true). Default off: the engine scores
 * live data (opportunities, analyses) but fabricates no fills, positions, or
 * signatures. Build-time value — restart dev after changing.
 */
export const PAPER_MODE = process.env.NEXT_PUBLIC_DESK_PAPER_MODE === "true";

/** EIP-712 domain + typed order the executor signs with MetaMask (Arbitrum One). */
const DESK_PERP_DOMAIN = {
  name: "Trading Desk Perps",
  version: "1",
  chainId: 42161,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
const PERP_ORDER_TYPES = [
  { name: "symbol", type: "string" },
  { name: "side", type: "string" },
  { name: "qty", type: "string" },
  { name: "entryPrice", type: "string" },
  { name: "leverage", type: "string" },
  { name: "notionalUsd", type: "string" },
  { name: "liqPrice", type: "string" },
  { name: "takeProfit", type: "string" },
  { name: "stopLoss", type: "string" },
  { name: "expiresAt", type: "uint256" },
  { name: "nonce", type: "string" },
];

function ev(agent: AgentId, type: AgentEventType, title: string, detail: string, payload?: Record<string, unknown>): AgentEvent {
  return { id: uid("evt"), agent, type, title, detail, payload, at: Date.now() };
}

function pushEvent(state: DeskState, e: AgentEvent) {
  state.events = [e, ...state.events].slice(0, MAX_EVENTS);
}

function setAgent(
  state: DeskState,
  id: AgentId,
  patch: Partial<DeskState["agents"][AgentId]>
) {
  state.agents[id] = { ...state.agents[id], ...patch };
}

export function runTick(state: DeskState): void {
  state.tick += 1;
  state.now = Date.now();

  // 1. Prices move only via live blends (store poll -> applyLivePrices).
  // Stale pairs hold their last live values; nothing is simulated.
  markPositions(state);
  markPerps(state);

  // 2. Synchronous pipeline: scout -> analyst -> executor, same tick.
  const found = scoutPhase(state);
  const scored = analystPhase(state, found);
  executorPhase(state, scored);

  // 3. Scheduled jobs.
  runDueJobs(state);
}

function markPositions(state: DeskState) {
  for (const pos of state.positions) {
    const pair = state.pairs.find((p) => p.base === pos.symbol.split("/")[0]);
    if (!pair) continue;
    pos.markPrice = pair.price;
    const move = (pair.price / pos.entryPrice - 1) * 100 * (pos.side === "long" ? 1 : -1);
    pos.pnlPct = move;
    pos.pnl = (pos.notionalUsd * move) / 100;
  }
}

// ---------- SCOUT ----------

function scoutPhase(state: DeskState): Opportunity[] {
  const scout = state.agents.scout;
  scout.state = "scanning";
  scout.heartbeatAt = state.now;
  scout.cycle += 1;

  // Live data only: pairs never blended (or gone stale) carry reference
  // values, not market truth — scoring them would invent opportunities.
  const tradeable = state.pairs.filter(
    (p) => p.liveLastAt !== null && state.now - p.liveLastAt <= STALE_MS
  );
  if (tradeable.length === 0) {
    scout.currentTask = "Waiting for live feed — no fresh pairs";
    scout.lastOutput = "Idle: feed stale or unreachable";
    scout.state = "idle";
    return [];
  }
  scout.currentTask = `Scanning ${tradeable.length} live pairs across Solana + EVM`;

  const found: Opportunity[] = [];
  const maxNew = 1 + (Math.random() < 0.35 ? 1 : 0);

  for (const pair of shuffled(tradeable).slice(0, tradeable.length)) {
    if (found.length >= maxNew) break;
    const heat = Math.abs(pair.change24h) / 8 + pair.volatility * 0.5;
    if (heat > 0.75 && Math.random() < 0.5) {
      found.push({
        id: uid("opp"),
        pairId: pair.id,
        symbol: pair.symbol,
        chain: pair.chain,
        foundAt: state.now,
        momentum: clamp(Math.abs(pair.change24h) / 8, 0, 1),
        liquidityScore: clamp(pair.liquidity / 60_000_000, 0, 1),
        volRisk: pair.volatility,
        bias: pair.change24h >= 0 ? "long" : "short",
        status: "pending",
      });
    }
  }

  for (const opp of found) {
    state.opportunities.unshift(opp);
    pushEvent(
      state,
      ev("scout", "opportunity", `Spotted ${opp.symbol}`, `Momentum ${(opp.momentum * 100).toFixed(0)}% · liq ${(opp.liquidityScore * 100).toFixed(0)}% · queued for analyst`, {
        opportunityId: opp.id,
        symbol: opp.symbol,
        chain: opp.chain,
        momentum: round2(opp.momentum),
        liquidity: round2(opp.liquidityScore),
      })
    );
  }

  scout.tasksDone += found.length;
  scout.lastOutput =
    found.length > 0
      ? `${found.length} candidate${found.length > 1 ? "s" : ""} → analyst`
      : "No fresh candidates this sweep";
  scout.state = "idle";
  return found;
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- ANALYST ----------

function analystPhase(state: DeskState, fresh: Opportunity[]): Analysis[] {
  const analyst = state.agents.analyst;
  analyst.state = "analyzing";
  analyst.heartbeatAt = state.now;

  const seen = new Set(fresh.map((o) => o.id));
  const backlog = state.opportunities.filter((o) => o.status === "pending" && !seen.has(o.id));
  // Rotate the backlog so the same pairs aren't re-scored every tick.
  const rotateBy = state.tick % Math.max(1, backlog.length);
  const rotated = [...backlog.slice(rotateBy), ...backlog.slice(0, rotateBy)];
  const queue = [...fresh, ...rotated].slice(0, 5);
  const out: Analysis[] = [];

  for (const opp of queue) {
    const pair = state.pairs.find((p) => p.id === opp.pairId);
    if (!pair) continue;

    const momentum = clamp(opp.momentum * 100 * 1.1 + (Math.random() - 0.3) * 15, 0, 100);
    const liquidity = clamp(opp.liquidityScore * 100 + (Math.random() - 0.5) * 10, 0, 100);
    const volatility = clamp(60 - opp.volRisk * 55 + (Math.random() - 0.5) * 10, 0, 100); // lower vol = higher score
    const trend = clamp(Math.abs(pair.change24h) * 9 + (Math.random() - 0.4) * 12, 0, 100);
    const final = clampScore(momentum * 0.34 + liquidity * 0.22 + volatility * 0.18 + trend * 0.26 + 14);

    const signal: "BUY" | "WATCH" | "SKIP" = final >= 62 ? "BUY" : final >= 44 ? "WATCH" : "SKIP";
    const confidence = clampScore(final + (Math.random() - 0.5) * 8);
    const note =
      signal === "BUY"
        ? `Momentum confirmed on ${pair.base}; depth sufficient for size`
        : signal === "WATCH"
          ? `Borderline setup — waiting for confirmation on ${pair.base}`
          : `Risk/reward unattractive on ${pair.base} right now`;

    const analysis: Analysis = {
      id: uid("ana"),
      opportunityId: opp.id,
      symbol: opp.symbol,
      chain: opp.chain,
      signal,
      confidence,
      breakdown: {
        momentum: Math.round(momentum),
        liquidity: Math.round(liquidity),
        volatility: Math.round(volatility),
        trend: Math.round(trend),
        final,
      },
      note,
      at: state.now,
    };

    opp.status = signal === "BUY" ? "analyzed" : signal === "SKIP" ? "skipped" : "pending";
    if (signal === "WATCH") opp.status = "pending";
    state.analyses.unshift(analysis);
    out.push(analysis);

    pushEvent(
      state,
      ev("analyst", signal === "BUY" ? "signal" : "analysis", `${signal} ${opp.symbol} @ ${confidence}%`, note, {
        analysisId: analysis.id,
        opportunityId: opp.id,
        signal,
        confidence,
        breakdown: analysis.breakdown,
      })
    );
  }

  // Paper ticket proposals (M6 harness): fake EIP-712 payloads are minted only
  // in paper mode. Scoring (opportunities, analyses) always continues.
  const newTickets = PAPER_MODE ? createPerpTickets(state, out) : [];
  if (newTickets.length) state.tickets = [...newTickets, ...state.tickets].slice(0, MAX_TICKETS);
  expireStaleTickets(state);

  analyst.tasksDone += out.length;
  analyst.cycle += 1;
  analyst.lastOutput = out.length
    ? `${out.filter((a) => a.signal === "BUY").length} BUY / ${out.length} scored · ${newTickets.length} ticket(s)`
    : "Queue empty";
  analyst.state = "idle";
  return out;
}

// ---------- PERP TICKETS + POSITIONS ----------

/** Random draw in [base - span/2, base + span/2]. */
function expPct(base: number, span: number) {
  return base * (1 - span / 2) + Math.random() * span;
}

function createPerpTickets(state: DeskState, analyses: Analysis[]): PerpTicket[] {
  // Curate: only high-conviction BUYs, one open proposal per symbol, max 2 per cycle
  // — otherwise every tick floods the ticket book.
  const openSymbols = new Set(state.tickets.filter((t) => t.status === "proposed").map((t) => t.symbol));
  const picks = analyses
    .filter((a) => a.signal === "BUY" && a.confidence >= 68 && !openSymbols.has(a.symbol))
    .slice(0, 2);
  const tickets: PerpTicket[] = [];
  for (const a of picks) {
    const pair = state.pairs.find((p) => p.symbol === a.symbol);
    if (!pair) continue;
    const opp = state.opportunities.find((o) => o.id === a.opportunityId);
    const side: "long" | "short" = opp?.bias ?? (Math.random() < 0.5 ? "long" : "short");

    // Risk sizing: margin is a fraction of connected-wallet equity
    // (0.5% + confidence*2%, volatility-trimmed, $50 min, 10% of equity max).
    // Falls back to the legacy fixed sizer when equity is unknown.
    const equity = state.accountEquityUsd;
    let sizeUsd: number;
    let sizingNote: string;
    if (equity !== null && equity > 0) {
      const sized = sizeMarginFromEquity(equity, a.confidence, pair.volatility);
      sizeUsd = sized.marginUsd;
      sizingNote = ` · ${(sized.riskFrac * 100).toFixed(1)}% of $${Math.round(equity).toLocaleString()} equity`;
    } else {
      sizeUsd = Math.max(500, Math.round((1_500 + (a.confidence / 100) * 3_500) * (1 - pair.volatility * 0.35)));
      sizingNote = " · fixed size (wallet disconnected)";
    }
    // Leverage: calmer pairs get more room, confidence adds a touch. 2..10x.
    const leverage = Math.round(clamp(11 - pair.volatility * 9 + (a.confidence / 100) * 2, 2, 10));

    const drift = expPct(0.045, 0.03); // expected favorable price move 3..6%
    const entry = pair.price;
    const liqDistance = 0.92 / leverage; // ~8% margin cushion at liq
    const takeProfit = side === "long" ? entry * (1 + drift) : entry * (1 - drift);
    const stopLoss = side === "long" ? entry * (1 - drift * 0.6) : entry * (1 + drift * 0.6);
    const liqPrice = side === "long" ? entry * (1 - liqDistance) : entry * (1 + liqDistance);

    const ticket: PerpTicket = {
      id: uid("tkt"),
      analysisId: a.id,
      opportunityId: a.opportunityId,
      symbol: pair.symbol,
      chain: pair.chain,
      side,
      entryPrice: entry,
      sizeUsd,
      leverage,
      notionalUsd: sizeUsd * leverage,
      liqPrice,
      takeProfit,
      stopLoss,
      confidence: a.confidence,
      breakdown: a.breakdown,
      note: `${side === "long" ? "Long" : "Short"} bias from ${side === "long" ? "positive" : "negative"} momentum · lev ${leverage}x · risk-sized $${sizeUsd.toLocaleString()}${sizingNote}`,
      status: "proposed",
      createdAt: state.now,
      expiresAt: state.now + TICKET_TTL_MS,
      equityUsd: equity,
      order: {
        domain: DESK_PERP_DOMAIN,
        primaryType: "PerpOrder",
        types: { PerpOrder: PERP_ORDER_TYPES },
        message: {
          symbol: pair.symbol,
          side,
          qty: ((sizeUsd * leverage) / entry).toFixed(6),
          entryPrice: entry.toPrecision(8),
          leverage: String(leverage),
          notionalUsd: (sizeUsd * leverage).toFixed(2),
          liqPrice: liqPrice.toPrecision(8),
          takeProfit: takeProfit.toPrecision(8),
          stopLoss: stopLoss.toPrecision(8),
          expiresAt: Math.floor((state.now + TICKET_TTL_MS) / 1000),
          nonce: `0x${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`,
        },
      },
    };
    tickets.push(ticket);

    pushEvent(
      state,
      ev("analyst", "ticket", `TICKET ${side.toUpperCase()} ${pair.symbol} ${leverage}x`, `Entry ${entry.toPrecision(6)} · size $${sizeUsd.toLocaleString()} · liq ${liqPrice.toPrecision(6)} · TP/SL ±${(drift * 100 * leverage).toFixed(0)}% margin · expires 90s`, {
        ticketId: ticket.id,
        symbol: pair.symbol,
        side,
        leverage,
        sizeUsd,
        equityUsd: equity,
        liqPrice,
      })
    );
  }
  return tickets;
}

function expireStaleTickets(state: DeskState) {
  for (const t of state.tickets) {
    if (t.status === "proposed" && t.expiresAt <= state.now) {
      t.status = "expired";
      pushEvent(state, ev("executor", "ticket", `TICKET expired ${t.symbol}`, `No signature within TTL — ${t.side} ${t.leverage}x returned to book`));
    }
  }
}

function markPerps(state: DeskState) {
  for (const pos of state.perpPositions) {
    if (pos.status !== "open") continue;
    const pair = state.pairs.find((p) => p.symbol === pos.symbol);
    if (!pair) continue;
    pos.markPrice = pair.price;
    const movePct = ((pair.price / pos.entryPrice - 1) * 100) * (pos.side === "long" ? 1 : -1);
    pos.pnlPct = movePct * pos.leverage;
    pos.pnl = (pos.marginUsd * pos.pnlPct) / 100;

    const liqHit = pos.side === "long" ? pair.price <= pos.liqPrice : pair.price >= pos.liqPrice;
    const tpHit = pos.side === "long" ? pair.price >= pos.takeProfit : pair.price <= pos.takeProfit;
    const slHit = pos.side === "long" ? pair.price <= pos.stopLoss : pair.price >= pos.stopLoss;
    if (liqHit) closePerpPosition(state, pos.id, "liquidation");
    else if (tpHit) closePerpPosition(state, pos.id, "take-profit");
    else if (slHit) closePerpPosition(state, pos.id, "stop-loss");
  }
}

export function closePerpPosition(
  state: DeskState,
  posId: string,
  via: "take-profit" | "stop-loss" | "liquidation" | "manual"
) {
  const pos = state.perpPositions.find((p) => p.id === posId);
  if (!pos || pos.status !== "open") return;
  const pair = state.pairs.find((p) => p.symbol === pos.symbol);
  const exitPrice = pair ? pair.price : pos.markPrice;
  const movePct = ((exitPrice / pos.entryPrice - 1) * 100) * (pos.side === "long" ? 1 : -1);
  const pnlPct = Math.max(movePct * pos.leverage, -98); // never worse than -98% of margin
  const realized = (pos.marginUsd * pnlPct) / 100;

  pos.status = "closed";
  pos.closedVia = via;
  pos.closedAt = state.now;
  pos.markPrice = exitPrice;
  pos.pnlPct = pnlPct;
  pos.pnl = realized;
  pos.realizedPnl = realized;

  pushEvent(
    state,
    ev("executor", "fill", `${via === "manual" ? "CLOSE" : via === "liquidation" ? "LIQUIDATED" : "TP/SL"} ${pos.symbol} ${pos.leverage}x`, `${pos.side} closed @ ${exitPrice.toPrecision(6)} · ${via} · P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% margin ($${realized.toFixed(2)})`, {
      perpPositionId: pos.id,
      symbol: pos.symbol,
      via,
      pnlPct: round2(pnlPct),
      realizedPnl: round2(realized),
    })
  );
}

// ---------- EXECUTOR ----------

function executorPhase(state: DeskState, analyses: Analysis[]) {
  const executor = state.agents.executor;
  executor.heartbeatAt = state.now;
  if (!PAPER_MODE) {
    // M6: no paper fills outside the dev harness. Live flow is explicit via
    // the Perps Desk venue panel. `analyses` intentionally unused here.
    void analyses;
    executor.state = "idle";
    executor.currentTask = "Paper executor disabled — live orders via Perps Desk";
    executor.lastOutput = "No paper fills (M6)";
    return;
  }
  executor.state = "executing";

  const buys = analyses.filter((a) => a.signal === "BUY");
  const maxNew = Math.max(0, 3 - state.positions.length);

  for (const a of buys.slice(0, Math.max(0, maxNew))) {
    const pair = state.pairs.find((p) => p.symbol === a.symbol);
    if (!pair) continue;

    const notionalUsd = 2_500 + Math.random() * 4_000;
    const qty = notionalUsd / pair.price;
    const slippage = 0.02 + Math.random() * 0.12; // percent
    const fee = (notionalUsd * 0.0004);
    const fillPrice = pair.price * (1 + slippage / 100);

    const trade: Trade = {
      id: uid("trd"),
      symbol: pair.symbol,
      chain: pair.chain,
      side: "buy",
      qty,
      price: fillPrice,
      slippage,
      fee,
      notional: notionalUsd,
      at: state.now,
      sourceOpportunityId: a.opportunityId,
    };
    state.trades.unshift(trade);

    const opp = state.opportunities.find((o) => o.id === a.opportunityId);
    if (opp) opp.status = "executed";

    const existing = state.positions.find((p) => p.symbol === pair.symbol);
    if (existing) {
      const totalQty = existing.qty + qty;
      existing.entryPrice = (existing.entryPrice * existing.qty + fillPrice * qty) / totalQty;
      existing.qty = totalQty;
      existing.notionalUsd += notionalUsd;
      existing.markPrice = pair.price;
      existing.pnlPct = (pair.price / existing.entryPrice - 1) * 100;
      existing.pnl = (existing.notionalUsd * existing.pnlPct) / 100;
    } else {
      state.positions.push({
        id: uid("pos"),
        symbol: pair.symbol,
        chain: pair.chain,
        side: "long",
        entryPrice: fillPrice,
        markPrice: pair.price,
        qty,
        notionalUsd,
        openedAt: state.now,
        pnlPct: (pair.price / fillPrice - 1) * 100,
        pnl: (notionalUsd * (pair.price / fillPrice - 1) * 100) / 100,
      });
    }

    pushEvent(
      state,
      ev("executor", "order", `BUY ${pair.base} · $${Math.round(notionalUsd).toLocaleString()}`, `Paper-filled @ ${fillPrice.toPrecision(6)} · slip ${slippage.toFixed(3)}% · fee $${fee.toFixed(2)}`, {
        tradeId: trade.id,
        symbol: pair.symbol,
        side: "buy",
        qty,
        price: fillPrice,
        notionalUsd,
      })
    );
    executor.tasksDone += 1;
  }

  // Occasional profit-taking sell.
  if (state.positions.length && Math.random() < 0.18) {
    const pos = state.positions.reduce((a, b) => (a.pnlPct > b.pnlPct ? a : b));
    if (pos.pnlPct > 0.15) closePosition(state, pos.id, "take-profit");
  }

  executor.cycle += 1;
  executor.lastOutput = buys.length ? `${Math.min(buys.length, maxNew)} order(s) routed` : "No actionable signals";
  executor.state = "idle";
}

function closePosition(state: DeskState, posId: string, reason: string) {
  const pos = state.positions.find((p) => p.id === posId);
  if (!pos) return;
  const slippage = 0.02 + Math.random() * 0.1;
  const fillPrice = pos.markPrice * (1 - slippage / 100);
  const notional = pos.qty * fillPrice;
  const fee = notional * 0.0004;

  state.trades.unshift({
    id: uid("trd"),
    symbol: pos.symbol,
    chain: pos.chain,
    side: "sell",
    qty: pos.qty,
    price: fillPrice,
    slippage,
    fee,
    notional,
    at: state.now,
  });

  state.positions = state.positions.filter((p) => p.id !== posId);
  pushEvent(
    state,
    ev("executor", "fill", `SELL ${pos.symbol} · ${reason}`, `Closed @ ${fillPrice.toPrecision(6)} · P&L ${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(2)}%`, {
      symbol: pos.symbol,
      reason,
      pnlPct: round2(pos.pnlPct),
    })
  );
}

// ---------- JOBS ----------

/** Handler registry: job behavior is bound to kind, not id, so user-added
 *  jobs run the same handlers as the built-ins. Unknown kinds warn and skip —
 *  a bad job must never crash the tick. */
const JOB_HANDLERS: Record<JobKind, (state: DeskState, job: ScheduledJob) => void> = {
  scan: (state) => {
    pushEvent(state, ev("scout", "job", "Job: market scan", `Swept ${state.pairs.length} pairs · ${state.opportunities.filter((o) => o.status === "pending").length} pending in queue`));
  },
  analysis: (state) => {
    pushEvent(state, ev("analyst", "job", "Job: signal refresh", `${state.analyses.length} lifetime scores · ${state.opportunities.filter((o) => o.status === "pending").length} awaiting review`));
  },
  exec: (state) => {
    pushEvent(state, ev("executor", "job", "Job: signal sweep", `${state.trades.length} lifetime fills · ${state.positions.length} open positions`));
  },
  rebalance: (state) => {
    rebalance(state);
  },
  risk: (state) => {
    riskSweep(state);
  },
  heartbeat: (state) => {
    for (const id of ["scout", "analyst", "executor"] as AgentId[]) {
      setAgent(state, id, { heartbeatAt: state.now });
    }
    pushEvent(state, ev("scout", "heartbeat", "Heartbeat OK", "All 3 agents responsive · pipeline latency nominal"));
  },
};

function runDueJobs(state: DeskState) {
  const now = state.now;
  for (const job of state.jobs) {
    if (job.paused || now < job.nextRunAt) continue;
    job.lastRunAt = now;
    job.runCount += 1;
    job.nextRunAt = now + job.intervalMs;

    const handler = JOB_HANDLERS[job.kind];
    if (!handler) {
      pushEvent(state, ev("scout", "job", `Job skipped: unknown kind`, `Job "${job.name}" has kind "${job.kind}" — no handler registered`, { jobId: job.id }));
      continue;
    }
    handler(state, job);
  }
}

function rebalance(state: DeskState) {
  if (!PAPER_MODE) return; // nothing paper to rebalance outside the harness
  for (const pos of [...state.positions]) {
    if (pos.pnlPct > 6) closePosition(state, pos.id, "rebalance: take-profit");
    else if (pos.pnlPct < -4) closePosition(state, pos.id, "rebalance: stop-loss");
  }
}

function riskSweep(state: DeskState) {
  const worst = state.positions.reduce<Position | null>((a, b) => (!a || b.pnlPct < a.pnlPct ? b : a), null);
  if (worst && worst.pnlPct < -2.5) {
    pushEvent(state, ev("analyst", "risk", `Risk flag: ${worst.symbol}`, `Drawdown ${worst.pnlPct.toFixed(2)}% — flagged for executor review`, { symbol: worst.symbol }));
  } else {
    pushEvent(state, ev("analyst", "risk", "Risk sweep clean", `Book exposure within limits across ${state.positions.length} positions`));
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
