/**
 * Account equity — the single source of truth for "how much is this wallet
 * worth" (client-safe, pure). Used by the dashboard balance display, the
 * ticket sizing in the engine, and the live-order suggested margin.
 *
 * Mirrors the header wallet valuation: native balance x desk live price,
 * demo wallet at its fixed paper value. Null = unknown (disconnected,
 * loading, or no live price yet).
 */
import type { MarketPair } from "./types";

export interface WalletSnapshot {
  kind: "phantom" | "metamask" | "demo" | null;
  balance: number | null;
  demoBalanceUsd: number | null;
}

export function accountEquityUsd(w: WalletSnapshot, pairs: MarketPair[]): number | null {
  if (w.kind === "demo") return w.demoBalanceUsd;
  if (w.kind !== "phantom" && w.kind !== "metamask") return null;
  if (w.balance === null || !Number.isFinite(w.balance) || w.balance < 0) return null;
  const pairId = w.kind === "phantom" ? "sol-sol" : "evm-eth";
  const price = pairs.find((p) => p.id === pairId)?.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  return w.balance * price;
}

/** Margin sizing bounds. Tune per venue (GMX dust positions can fail back). */
export const MARGIN_MIN_USD = 50;
const RISK_BASE_FRAC = 0.005; // 0.5% of equity at zero confidence
const RISK_CONF_FRAC = 0.02; // up to +2.0% at full confidence
const EQUITY_MAX_FRAC = 0.1; // never risk more than 10% of equity per ticket

/**
 * Margin for one ticket as a fraction of account equity, scaled by confidence
 * and trimmed by pair volatility (same trim the legacy sizer used).
 * Returns whole dollars.
 */
export function sizeMarginFromEquity(
  equityUsd: number,
  confidence: number,
  volatility: number
): { marginUsd: number; riskFrac: number } {
  const conf = Math.max(0, Math.min(100, confidence));
  const vol = Math.max(0, Math.min(1, volatility));
  const riskFrac = RISK_BASE_FRAC + (conf / 100) * RISK_CONF_FRAC;
  const raw = equityUsd * riskFrac * (1 - vol * 0.35);
  const marginUsd = Math.max(MARGIN_MIN_USD, Math.min(Math.round(raw), equityUsd * EQUITY_MAX_FRAC));
  return { marginUsd, riskFrac };
}
