import type {
  AgentEvent,
  AgentId,
  Analysis,
  MarketPair,
  Opportunity,
  PerpPosition,
  PerpTicket,
  Position,
  ScheduledJob,
  Trade,
} from "./types";
import { clamp } from "./rng";

export interface DeskState {
  running: boolean;
  tick: number;
  now: number;
  pairs: MarketPair[];
  opportunities: Opportunity[]; // newest first
  analyses: Analysis[]; // newest first
  positions: Position[];
  trades: Trade[]; // newest first
  events: AgentEvent[]; // newest first
  agents: Record<AgentId, { state: string; currentTask: string; lastOutput: string; heartbeatAt: number; cycle: number; tasksDone: number }>;
  jobs: ScheduledJob[];
  startedAt: number;
  /** Where current prices came from: pure simulation or a live feed. */
  marketSource: "sim" | "coingecko" | "binance";
  /** Timestamp of the last successful live-price blend (null = never). */
  lastLiveAt: number | null;
  /** Analyst-generated perp trade tickets (newest first). */
  tickets: PerpTicket[];
  /** Leveraged positions opened from executed tickets (open + closed, newest first). */
  perpPositions: PerpPosition[];
  /** Connected-wallet equity in USD (lib/account.ts) — drives ticket sizing.
   *  Null when disconnected/loading. Refreshed every tick from wallet+prices. */
  accountEquityUsd: number | null;
}

export const TICK_MS = 2000;

export function createJobs(now: number): ScheduledJob[] {
  return [
    {
      id: "job-scan",
      kind: "scan",
      builtIn: true,
      agent: "scout",
      name: "Market scan",
      description: "Sweep all pairs for fresh momentum & liquidity anomalies",
      intervalMs: 20_000,
      nextRunAt: now + 20_000,
      lastRunAt: now,
      runCount: 0,
      paused: false,
    },
    {
      id: "job-analysis",
      kind: "analysis",
      builtIn: true,
      agent: "analyst",
      name: "Signal refresh",
      description: "Re-score open opportunities, expire stale ones",
      intervalMs: 20_000,
      nextRunAt: now + 20_000,
      lastRunAt: now,
      runCount: 0,
      paused: false,
    },
    {
      id: "job-exec",
      kind: "exec",
      builtIn: true,
      agent: "executor",
      name: "Signal sweep",
      description: "Pick up analyst BUY signals and paper-execute",
      intervalMs: 20_000,
      nextRunAt: now + 20_000,
      lastRunAt: now,
      runCount: 0,
      paused: false,
    },
    {
      id: "job-rebalance",
      kind: "rebalance",
      builtIn: true,
      agent: "executor",
      name: "Portfolio rebalance",
      description: "Trim positions > 20% of book, take profit > +6%",
      intervalMs: 300_000,
      nextRunAt: now + 300_000,
      lastRunAt: now,
      runCount: 0,
      paused: false,
    },
    {
      id: "job-risk",
      kind: "risk",
      builtIn: true,
      agent: "analyst",
      name: "Risk sweep",
      description: "Check drawdown and volatility spikes across book",
      intervalMs: 120_000,
      nextRunAt: dueIn(90_000, now),
      lastRunAt: null,
      runCount: 0,
      paused: false,
    },
    {
      id: "job-heartbeat",
      kind: "heartbeat",
      builtIn: true,
      agent: "system",
      name: "Health heartbeat",
      description: "All agents ping in, verify pipeline is alive",
      intervalMs: 60_000,
      nextRunAt: now + 60_000,
      lastRunAt: now,
      runCount: 0,
      paused: false,
    },
  ];
}

function dueIn(ms: number, now: number) {
  return now + ms;
}

export function createAgentRuntimes(now: number) {
  return {
    scout: { state: "idle", currentTask: "Booting scanner…", lastOutput: "—", heartbeatAt: now, cycle: 0, tasksDone: 0 },
    analyst: { state: "idle", currentTask: "Booting model…", lastOutput: "—", heartbeatAt: now, cycle: 0, tasksDone: 0 },
    executor: { state: "idle", currentTask: "Booting executor…", lastOutput: "—", heartbeatAt: now, cycle: 0, tasksDone: 0 },
  };
}

export function totalPnl(positions: Position[], trades: Trade[]): number {
  let realized = 0;
  for (const t of trades) realized += t.side === "sell" ? 0 : 0; // realized baked into equity below
  void realized;
  let unrealized = 0;
  for (const p of positions) unrealized += p.pnl;
  return unrealized;
}

export function equity(state: DeskState): number {
  const base = 100_000;
  let pnl = 0;
  for (const p of state.positions) pnl += p.pnl;
  // closed-trade P&L is approximated from trades (sell notional minus avg buy notional per symbol)
  return base + pnl + realizedPnl(state.trades);
}

// Simple average-cost realized P&L from the trade blotter (chronological order).
export function realizedPnl(trades: Trade[]): number {
  const avgCost: Record<string, { qty: number; cost: number }> = {};
  let realized = 0;
  for (const t of [...trades].sort((a, b) => a.at - b.at)) {
    const key = t.symbol;
    const book = (avgCost[key] ??= { qty: 0, cost: 0 });
    if (t.side === "buy") {
      book.qty += t.qty;
      book.cost += t.notional;
    } else {
      if (book.qty > 0) {
        const avgPrice = book.cost / book.qty;
        realized += (t.price - avgPrice) * t.qty - t.fee;
        book.qty -= t.qty;
        book.cost = avgPrice * book.qty;
      }
    }
  }
  return realized;
}

export function winRate(trades: Trade[]): number {
  // count sells that closed above avg cost as wins
  const avgCost: Record<string, { qty: number; cost: number }> = {};
  let wins = 0;
  let closed = 0;
  for (const t of [...trades].sort((a, b) => a.at - b.at)) {
    const book = (avgCost[t.symbol] ??= { qty: 0, cost: 0 });
    if (t.side === "buy") {
      book.qty += t.qty;
      book.cost += t.notional;
    } else if (book.qty > 0) {
      const avgPrice = book.cost / book.qty;
      if (t.price > avgPrice) wins += 1;
      closed += 1;
      book.qty -= t.qty;
      book.cost = avgPrice * book.qty;
    }
  }
  return closed === 0 ? 0 : (wins / closed) * 100;
}

export function clampScore(n: number) {
  return clamp(Math.round(n), 0, 100);
}
