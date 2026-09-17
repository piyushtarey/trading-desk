/**
 * POST /api/orders/track  { txHash }
 * -> { status: "pending" | "success" | "reverted", blockNumber, txHash }
 *
 * Read-only receipt lookup for a user-submitted order-creation tx.
 * "success" means the creation tx landed — on GMX a keeper still has to
 * execute the order afterwards, so creation is NOT a fill.
 */

import { NextRequest } from "next/server";
import { isLiveOrdersEnabled } from "@/lib/server/trading";
import { getGmxConfig, getTxReceipt } from "@/lib/server/venue/gmx";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isLiveOrdersEnabled()) {
    return Response.json({ error: "live orders disabled (DESK_LIVE_ORDERS_ENABLED)" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const txHash = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof txHash.txHash !== "string") {
    return Response.json({ error: "txHash must be a string" }, { status: 400 });
  }
  const venue = getGmxConfig();
  if (!venue.ok) {
    return Response.json({ error: `venue-not-configured (${venue.error})` }, { status: 503 });
  }
  try {
    return Response.json(await getTxReceipt(venue.config, txHash.txHash));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "receipt lookup failed" }, { status: 502 });
  }
}
