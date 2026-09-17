/**
 * Shared risk primitives — client-safe (pure, no env, no secrets).
 * Server enforcement lives in `lib/server/trading.ts` + `app/api/orders/intent`.
 */

export interface RiskCaps {
  /** Max notional (margin x leverage) per single order, USD. */
  maxNotionalPerTradeUsd: number;
  /** Max leverage per order. */
  maxLeverage: number;
  /** Max simultaneously open positions. */
  maxOpenPositions: number;
  /** Block new risk once realized day P&L is at or below -maxDailyLossUsd. */
  maxDailyLossUsd: number;
}

/** Conservative canary defaults. Fail small, raise deliberately. */
export const DEFAULT_CAPS: RiskCaps = {
  maxNotionalPerTradeUsd: 1000,
  maxLeverage: 5,
  maxOpenPositions: 3,
  maxDailyLossUsd: 500,
};

/** Absolute ceiling regardless of configured caps — sanity bound, not a target. */
export const ABSOLUTE_MAX_LEVERAGE = 25;

export type OrderSide = "long" | "short";

export interface OrderIntent {
  symbol: string; // e.g. "SOL/USDC"
  side: OrderSide;
  /** Margin committed, USD. */
  sizeUsd: number;
  leverage: number;
  /** Optional limit/trigger levels, USD price. */
  entryPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface IntentContext {
  openPositions: number;
  /** Realized P&L for the current UTC day, USD (negative = losing day). */
  dailyRealizedPnl: number;
}

export const DEFAULT_INTENT_CONTEXT: IntentContext = { openPositions: 0, dailyRealizedPnl: 0 };

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Strict shape validation for an untrusted order-intent payload. */
export function validateOrderIntent(input: unknown): { ok: true; intent: OrderIntent } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "intent must be an object" };
  const v = input as Record<string, unknown>;

  if (typeof v.symbol !== "string" || !/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(v.symbol)) {
    return { ok: false, error: "symbol must look like BASE/QUOTE (e.g. SOL/USDC)" };
  }
  if (v.side !== "long" && v.side !== "short") return { ok: false, error: 'side must be "long" or "short"' };
  if (!isFinitePositive(v.sizeUsd)) return { ok: false, error: "sizeUsd must be a positive number" };
  if (typeof v.leverage !== "number" || !Number.isFinite(v.leverage) || v.leverage < 1) {
    return { ok: false, error: "leverage must be a number >= 1" };
  }
  if (v.leverage > ABSOLUTE_MAX_LEVERAGE) {
    return { ok: false, error: `leverage exceeds absolute ceiling (${ABSOLUTE_MAX_LEVERAGE}x)` };
  }
  for (const k of ["entryPrice", "takeProfit", "stopLoss"] as const) {
    if (v[k] !== undefined && !isFinitePositive(v[k])) {
      return { ok: false, error: `${k} must be a positive number when provided` };
    }
  }

  const intent: OrderIntent = { symbol: v.symbol, side: v.side, sizeUsd: v.sizeUsd, leverage: v.leverage };
  if (typeof v.entryPrice === "number") intent.entryPrice = v.entryPrice;
  if (typeof v.takeProfit === "number") intent.takeProfit = v.takeProfit;
  if (typeof v.stopLoss === "number") intent.stopLoss = v.stopLoss;
  return { ok: true, intent };
}

/** Validate the caller-supplied risk context (venue-derived in M3, asserted for now). */
export function validateIntentContext(input: unknown): { ok: true; context: IntentContext } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, context: { ...DEFAULT_INTENT_CONTEXT } };
  if (typeof input !== "object" || input === null) return { ok: false, error: "context must be an object" };
  const v = input as Record<string, unknown>;
  const openPositions = v.openPositions ?? 0;
  const dailyRealizedPnl = v.dailyRealizedPnl ?? 0;
  if (typeof openPositions !== "number" || !Number.isInteger(openPositions) || openPositions < 0) {
    return { ok: false, error: "context.openPositions must be a non-negative integer" };
  }
  if (typeof dailyRealizedPnl !== "number" || !Number.isFinite(dailyRealizedPnl)) {
    return { ok: false, error: "context.dailyRealizedPnl must be a finite number" };
  }
  return { ok: true, context: { openPositions, dailyRealizedPnl } };
}

export interface CapRejection {
  code: "NOTIONAL_CAP" | "LEVERAGE_CAP" | "POSITION_CAP" | "DAILY_LOSS_LIMIT";
  message: string;
}

/** Pure caps check. Returns null when the intent passes. */
export function checkCaps(intent: OrderIntent, caps: RiskCaps, ctx: IntentContext): CapRejection | null {
  const notional = intent.sizeUsd * intent.leverage;
  if (notional > caps.maxNotionalPerTradeUsd) {
    return {
      code: "NOTIONAL_CAP",
      message: `notional $${notional.toLocaleString()} exceeds per-trade cap $${caps.maxNotionalPerTradeUsd.toLocaleString()}`,
    };
  }
  if (intent.leverage > caps.maxLeverage) {
    return { code: "LEVERAGE_CAP", message: `leverage ${intent.leverage}x exceeds cap ${caps.maxLeverage}x` };
  }
  if (ctx.openPositions >= caps.maxOpenPositions) {
    return {
      code: "POSITION_CAP",
      message: `already at max open positions (${caps.maxOpenPositions})`,
    };
  }
  if (ctx.dailyRealizedPnl <= -caps.maxDailyLossUsd) {
    return {
      code: "DAILY_LOSS_LIMIT",
      message: `daily loss limit hit (day P&L $${ctx.dailyRealizedPnl.toLocaleString()}, limit $${caps.maxDailyLossUsd.toLocaleString()})`,
    };
  }
  return null;
}

/**
 * Decrease (exit) intent: closing/reducing a venue position. Closes only
 * reduce exposure, so they pass the kill switch + validation but intentionally
 * bypass NOTIONAL/POSITION/DAILY caps — a losing day must never block exits.
 */
export interface DecreaseIntent {
  symbol: string;
  side: "long" | "short"; // side of the POSITION being closed
  /** Position size to close, USD. */
  sizeDeltaUsd: number;
  /** Collateral to withdraw, USD. */
  collateralDeltaUsd: number;
}

export function validateDecreaseIntent(input: unknown): { ok: true; intent: DecreaseIntent } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "decrease must be an object" };
  const v = input as Record<string, unknown>;
  if (typeof v.symbol !== "string" || !/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(v.symbol)) {
    return { ok: false, error: "symbol must look like BASE/QUOTE (e.g. ETH/USDC)" };
  }
  if (v.side !== "long" && v.side !== "short") return { ok: false, error: 'side must be "long" or "short"' };
  if (!isFinitePositive(v.sizeDeltaUsd)) return { ok: false, error: "sizeDeltaUsd must be a positive number" };
  if (!isFinitePositive(v.collateralDeltaUsd)) {
    return { ok: false, error: "collateralDeltaUsd must be a positive number" };
  }
  return { ok: true, intent: { symbol: v.symbol, side: v.side, sizeDeltaUsd: v.sizeDeltaUsd, collateralDeltaUsd: v.collateralDeltaUsd } };
}
