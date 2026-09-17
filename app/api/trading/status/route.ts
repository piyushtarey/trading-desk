/**
 * GET /api/trading/status -> { halted, reason, updatedAt, dryRun, liveOrders, caps }
 * Non-secret operational state for the UI banner. Safe to expose.
 */

import { getHaltState, getRiskCaps, isDryRun, isLiveOrdersEnabled } from "@/lib/server/trading";

export const dynamic = "force-dynamic";

export async function GET() {
  const halt = getHaltState();
  return Response.json({ ...halt, dryRun: isDryRun(), liveOrders: isLiveOrdersEnabled(), caps: getRiskCaps() });
}
