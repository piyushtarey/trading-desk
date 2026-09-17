export type AgentId = "scout" | "analyst" | "executor";

/** Fixed handler set for scheduled jobs — the add-job form picks from these. */
export type JobKind = "scan" | "analysis" | "exec" | "rebalance" | "risk" | "heartbeat";

export type AgentState = "idle" | "scanning" | "analyzing" | "executing" | "waiting";

export type Chain = "solana" | "evm";

export type Signal = "BUY" | "WATCH" | "SKIP";

export interface MarketPair {
  id: string;
  symbol: string; // e.g. "SOL/USDC"
  base: string;
  quote: string;
  chain: Chain;
  price: number;
  prevPrice: number;
  change24h: number; // percent
  volume24h: number;
  liquidity: number;
  volatility: number; // 0..1
  spark: number[]; // last N prices for sparkline
  /** Timestamp of the last live-feed blend (null while purely simulated). */
  liveLastAt: number | null;
}

export interface Opportunity {
  id: string;
  pairId: string;
  symbol: string;
  chain: Chain;
  foundAt: number;
  momentum: number; // 0..1
  liquidityScore: number; // 0..1
  volRisk: number; // 0..1
  /** Direction the scout derived from signed 24h momentum. */
  bias: "long" | "short";
  status: "pending" | "analyzed" | "executed" | "skipped";
}

export type PerpTicketStatus = "proposed" | "signed" | "executed" | "cancelled" | "expired";

/** Serialized EIP-712 payload the executor signs with MetaMask. */
export interface PerpOrderPayload {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  primaryType: string;
  types: Record<string, { name: string; type: string }[]>;
  message: {
    symbol: string;
    side: "long" | "short";
    qty: string;
    entryPrice: string;
    leverage: string;
    notionalUsd: string;
    liqPrice: string;
    takeProfit: string;
    stopLoss: string;
    expiresAt: number;
    nonce: string;
  };
}

/** A full trade ticket produced by the analyst, awaiting executor signature. */
export interface PerpTicket {
  id: string;
  analysisId: string;
  opportunityId: string;
  symbol: string;
  chain: Chain;
  side: "long" | "short";
  entryPrice: number;
  sizeUsd: number; // margin committed (risk-sized)
  leverage: number; // 2..10
  notionalUsd: number;
  liqPrice: number;
  takeProfit: number;
  stopLoss: number;
  confidence: number;
  breakdown: ScoreBreakdown;
  note: string;
  status: PerpTicketStatus;
  createdAt: number;
  expiresAt: number;
  /** Account equity (USD) the margin was sized from — null when unknown. */
  equityUsd?: number | null;
  signedBy?: string;
  signature?: string;
  order?: PerpOrderPayload;
}

export interface PerpPosition {
  id: string;
  ticketId: string;
  symbol: string;
  chain: Chain;
  side: "long" | "short";
  qty: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  marginUsd: number;
  notionalUsd: number;
  liqPrice: number;
  takeProfit: number;
  stopLoss: number;
  pnl: number; // leveraged USD
  pnlPct: number; // percent on margin
  openedAt: number;
  status: "open" | "closed";
  closedVia?: "take-profit" | "stop-loss" | "liquidation" | "manual";
  closedAt?: number;
  realizedPnl?: number;
}

export interface ScoreBreakdown {
  momentum: number;
  liquidity: number;
  volatility: number;
  trend: number;
  final: number; // 0..100
}

export interface Analysis {
  id: string;
  opportunityId: string;
  symbol: string;
  chain: Chain;
  signal: Signal;
  confidence: number; // 0..100
  breakdown: ScoreBreakdown;
  note: string;
  at: number;
}

export interface Position {
  id: string;
  symbol: string;
  chain: Chain;
  side: "long" | "short";
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  qty: number;
  openedAt: number;
  pnlPct: number;
  pnl: number;
}

export interface Trade {
  id: string;
  symbol: string;
  chain: Chain;
  side: "buy" | "sell";
  qty: number;
  price: number;
  slippage: number; // percent
  fee: number;
  notional: number;
  at: number;
  sourceOpportunityId?: string;
}

export interface ScheduledJob {
  id: string;
  /** Handler key — behavior is bound to kind, not id (lib/engine.ts registry). */
  kind: JobKind;
  /** False for user-added jobs. Built-ins are deletable but flagged. */
  builtIn: boolean;
  agent: AgentId | "system";
  name: string;
  description: string;
  intervalMs: number;
  nextRunAt: number;
  lastRunAt: number | null;
  runCount: number;
  paused: boolean;
}

export type AgentEventType =
  | "market_scan"
  | "opportunity"
  | "analysis"
  | "signal"
  | "ticket"
  | "order"
  | "fill"
  | "portfolio"
  | "risk"
  | "heartbeat"
  | "job";

export interface AgentEvent {
  id: string;
  agent: AgentId;
  type: AgentEventType;
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
  at: number;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  role: string;
  description: string;
  icon: string;
  accent: string; // tailwind-ish hex for accents
  state: AgentState;
  currentTask: string;
  lastOutput: string;
  heartbeatAt: number;
  cycle: number;
  tasksDone: number;
}
