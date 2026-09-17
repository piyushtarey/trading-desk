/**
 * GET /api/positions?account=0x…
 * -> { venue, chainId, account, positions: VenuePosition[], indexedNote }
 *
 * Read-only on-chain position visibility via the GMX indexer. Public data,
 * no keys involved. The indexer lags chain by seconds — display only, and
 * never a gate that blocks exits (see prepare).
 */

import { NextRequest } from "next/server";
import { isAddress } from "viem";
import { isLiveOrdersEnabled } from "@/lib/server/trading";
import { getGmxConfig } from "@/lib/server/venue/gmx";
import { getVenuePositions } from "@/lib/server/venue/positions";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isLiveOrdersEnabled()) {
    return Response.json({ error: "live orders disabled (DESK_LIVE_ORDERS_ENABLED)" }, { status: 403 });
  }
  const account = new URL(req.url).searchParams.get("account");
  if (!account || !isAddress(account)) {
    return Response.json({ error: "account must be an EVM address" }, { status: 400 });
  }
  const venue = getGmxConfig();
  if (!venue.ok) {
    return Response.json({ error: `venue-not-configured (${venue.error})` }, { status: 503 });
  }
  try {
    const positions = await getVenuePositions(venue.config, account);
    return Response.json({
      venue: "gmx-v2",
      chainId: venue.config.chainId,
      account,
      positions,
      indexedNote: "Indexer lags chain by seconds — recent fills may not appear yet.",
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "position lookup failed" }, { status: 502 });
  }
}
