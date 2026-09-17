/**
 * Server-only venue position reads (M5) via the GMX Subsquid indexer.
 * Read-only HTTPS — no keys, no signing. Indexer lags chain by seconds;
 * treat output as "recent truth", never as a gate that can block exits.
 *
 * Verified against the live schema 2026-09-18:
 * - `account_eq` is CASE-SENSITIVE — checksum-normalize before querying.
 * - live rows have `isSnapshot: false`.
 * - money fields are raw strings: sizeInUsd/entryPrice/unrealizedPnl in
 *   30-decimal USD, collateralAmount in collateral-token units, leverage /1e4.
 */

import { getAddress, isAddress } from "viem";
import type { GmxConfig, GmxMarketConfig } from "./gmx";

if (typeof window !== "undefined") {
  throw new Error("lib/server/venue imported from client code");
}

const SQUID_URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const FETCH_TIMEOUT_MS = 6_000;
const MAX_POSITIONS = 50;

export interface VenuePosition {
  positionKey: string;
  market: string;
  /** Desk symbol when the market is allowlisted, else null. */
  symbol: string | null;
  isLong: boolean;
  side: "long" | "short";
  collateralToken: string;
  /** Null when token decimals are unknown (not in allowlist). */
  sizeUsd: number | null;
  collateralUsd: number | null;
  entryPriceUsd: number | null;
  leverage: number | null;
  unrealizedPnlUsd: number | null;
  openedAt: number | null;
  /** Raw 30-decimal / token-unit strings for exact close construction. */
  raw: { sizeInUsd: string; collateralAmount: string; entryPrice: string };
}

interface SquidPosition {
  positionKey: string;
  market: string;
  collateralToken: string;
  isLong: boolean;
  collateralAmount: string;
  sizeInUsd: string;
  entryPrice: string;
  leverage: string;
  unrealizedPnl: string;
  openedAt: number;
}

function toUsd30(raw: string): number | null {
  try {
    return Number(BigInt(raw)) / 1e30;
  } catch {
    return null;
  }
}

function matchMarket(markets: GmxMarketConfig[], addr: string): GmxMarketConfig | null {
  const lower = addr.toLowerCase();
  return markets.find((m) => m.market.toLowerCase() === lower) ?? null;
}

function matchCollateralDecimals(markets: GmxMarketConfig[], token: string): number | null {
  const lower = token.toLowerCase();
  for (const m of markets) {
    if (m.collateralToken.toLowerCase() === lower) return m.collateralDecimals;
    if (m.longToken.toLowerCase() === lower || m.shortToken.toLowerCase() === lower) return 18;
  }
  return null;
}

/**
 * Open venue positions for an account. Throws on bad input, unsupported chain,
 * or indexer failure — callers decide whether to fail closed (prepare of new
 * risk) or warn-and-continue (exits must never be blocked by telemetry).
 */
export async function getVenuePositions(config: GmxConfig, account: string): Promise<VenuePosition[]> {
  if (!isAddress(account)) throw new Error("account must be an EVM address");
  if (config.chainId !== 42161) {
    throw new Error("venue position reads support Arbitrum One only (no testnet indexer configured)");
  }
  const checksummed = getAddress(account);
  const query = {
    query: `{ positions(where: {account_eq: "${checksummed}", isSnapshot_eq: false}, limit: ${MAX_POSITIONS}, orderBy: openedAt_DESC) { positionKey market collateralToken isLong collateralAmount sizeInUsd entryPrice leverage unrealizedPnl openedAt } }`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let json: { data?: { positions?: SquidPosition[] } };
  try {
    const res = await fetch(SQUID_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    json = (await res.json()) as typeof json;
  } finally {
    clearTimeout(timer);
  }
  const rows = json.data?.positions;
  if (!Array.isArray(rows)) throw new Error("indexer returned no positions array");

  return rows.map((r) => {
    const market = matchMarket(config.markets, r.market);
    const sizeUsd = toUsd30(r.sizeInUsd);
    const entryPriceUsd =
      market && /^\d+$/.test(r.entryPrice)
        ? Number(BigInt(r.entryPrice)) / 10 ** (30 - market.indexDecimals)
        : null;
    const colDec = matchCollateralDecimals(config.markets, r.collateralToken);
    const collateralUsd =
      colDec !== null && /^\d+$/.test(r.collateralAmount) ? Number(BigInt(r.collateralAmount)) / 10 ** colDec : null;
    const leverage = /^\d+$/.test(r.leverage) ? Number(BigInt(r.leverage)) / 1e4 : null;
    return {
      positionKey: r.positionKey,
      market: r.market,
      symbol: market?.symbol ?? null,
      isLong: r.isLong,
      side: r.isLong ? "long" : "short",
      collateralToken: r.collateralToken,
      sizeUsd,
      collateralUsd,
      entryPriceUsd,
      leverage,
      unrealizedPnlUsd: toUsd30(r.unrealizedPnl),
      openedAt: typeof r.openedAt === "number" ? r.openedAt * 1000 : null,
      raw: { sizeInUsd: r.sizeInUsd, collateralAmount: r.collateralAmount, entryPrice: r.entryPrice },
    };
  });
}
