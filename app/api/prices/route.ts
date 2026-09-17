/**
 * Live crypto prices API (server-side).
 *
 * Primary:  CoinGecko simple/price — one call covers the whole universe,
 *           includes 24h change. Free tier rate-limits aggressively, hence:
 * Fallback: Binance ticker/24hr (multi-symbol ping) — price, 24h change and
 *           quote volume per symbol. Non-USDT pairs are cross rates of the
 *           USD legs (JUP/SOL = JUPUSDT ÷ SOLUSDT, change derived from legs).
 *
 * The result is cached in-memory for 30s so all clients share one upstream call.
 * Response: { source, at, prices: Record<coinId, number>, changes24h?, volumes24h?, cached? }
 * Both sources failing -> 502 JSON (client holds last live prices, marks STALE).
 *
 * Upstream logic lives in lib/server/prices.ts so other server routes can take
 * an independent mark (see POST /api/orders/prepare).
 */

import { getPriceFeed } from "@/lib/server/prices";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getPriceFeed());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return Response.json({ error: `No upstream price source available (${msg})` }, { status: 502 });
  }
}
