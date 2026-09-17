/**
 * GET /api/orders/markets
 * -> { chainId, markets: [{ symbol, market, indexToken, indexDecimals, longToken, shortToken }], ... }
 *
 * The venue allowlist: only these symbols can be prepared. All addresses are
 * public on-chain data. 503 until live orders are enabled and configured.
 */

import { isLiveOrdersEnabled } from "@/lib/server/trading";
import { getGmxConfig } from "@/lib/server/venue/gmx";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isLiveOrdersEnabled()) {
    return Response.json({ error: "live orders disabled (DESK_LIVE_ORDERS_ENABLED)" }, { status: 403 });
  }
  const venue = getGmxConfig();
  if (!venue.ok) {
    return Response.json({ error: `venue-not-configured (${venue.error})` }, { status: 503 });
  }
  return Response.json({
    venue: "gmx-v2",
    chainId: venue.config.chainId,
    slippageBps: venue.config.slippageBps,
    executionFeeWei: venue.config.executionFeeWei.toString(),
    markets: venue.config.markets.map((m) => ({
      symbol: m.symbol,
      market: m.market,
      indexToken: m.indexToken,
      indexDecimals: m.indexDecimals,
      longToken: m.longToken,
      shortToken: m.shortToken,
      collateralToken: m.collateralToken,
      collateralDecimals: m.collateralDecimals,
    })),
  });
}
