/**
 * POST /api/orders/prepare  { kind?, intent?, decrease?, account, markPrice?, context? }
 *
 * M3/M5 live-order flow, step 1: run the gates, then quote GMX v2 and return
 * the UNSIGNED multicall for the user's wallet to send. The server never signs
 * or submits.
 *
 * - kind "increase" (default): full M1 gate (validate -> halt -> caps) ->
 *   MarketIncrease.
 * - kind "decrease": validate -> halt -> MarketDecrease. Caps are bypassed on
 *   purpose (closing reduces exposure; a losing day must never block exits).
 *   The account's venue position is checked when readable — mismatch rejects;
 *   unreadable telemetry only warns, never blocks an exit.
 *
 * Gates: DESK_LIVE_ORDERS_ENABLED=true required (403 otherwise); venue config
 * valid + contracts live (503 otherwise); server-side mark from our own feed
 * with a 2% divergence check against any client-supplied markPrice.
 */

import { NextRequest } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import {
  checkCaps,
  validateDecreaseIntent,
  validateIntentContext,
  validateOrderIntent,
  type DecreaseIntent,
  type OrderIntent,
} from "@/lib/risk";
import { getHaltState, getRiskCaps, isLiveOrdersEnabled, recordAudit } from "@/lib/server/trading";
import {
  assertContractsDeployed,
  buildDecreaseMulticall,
  buildIncreaseMulticall,
  getGmxConfig,
  quoteDecrease,
  quoteIncrease,
  type GmxConfig,
  type GmxMarketConfig,
  type PreparedGmxOrder,
} from "@/lib/server/venue/gmx";
import { getVenuePositions } from "@/lib/server/venue/positions";
import { getPriceFeed } from "@/lib/server/prices";

export const dynamic = "force-dynamic";

const MARK_DIVERGENCE_TOLERANCE = 0.02; // client mark must be within 2% of our feed

type Fail = { status: number; body: Record<string, unknown> };

async function sharedGates(
  payload: Record<string, unknown>
): Promise<Fail | { account: Address; clientMark: number | undefined }> {
  const account = payload.account;
  if (typeof account !== "string" || !isAddress(account)) {
    recordAudit("prepare_rejected", "rejected: account missing or not an address");
    return { status: 400, body: { error: "account must be an EVM address" } };
  }
  const clientMark = payload.markPrice;
  if (clientMark !== undefined && (typeof clientMark !== "number" || !Number.isFinite(clientMark) || clientMark <= 0)) {
    recordAudit("prepare_rejected", "rejected: markPrice must be a positive number when provided");
    return { status: 400, body: { error: "markPrice must be a positive number when provided" } };
  }
  return { account: getAddress(account), clientMark };
}

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
  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const kind = payload.kind ?? "increase";
  if (kind !== "increase" && kind !== "decrease") {
    return Response.json({ error: 'kind must be "increase" or "decrease"' }, { status: 400 });
  }

  const gates = await sharedGates(payload);
  if ("status" in gates) return Response.json(gates.body, { status: gates.status });
  const { account, clientMark } = gates;

  const halt = getHaltState();
  if (halt.halted) {
    recordAudit("prepare_rejected", `blocked by kill switch: ${halt.reason ?? "halted"}`);
    return Response.json({ error: "trading halted", reason: halt.reason }, { status: 423 });
  }

  if (kind === "increase") {
    return prepareIncrease(payload, account, clientMark);
  }
  return prepareDecrease(payload, account, clientMark);
}

async function loadMarket(symbol: string): Promise<Fail | { venue: GmxConfig; market: GmxMarketConfig }> {
  const venue = getGmxConfig();
  if (!venue.ok) {
    recordAudit("prepare_rejected", `venue not configured: ${venue.error}`);
    return { status: 503, body: { error: `venue-not-configured (${venue.error})` } };
  }
  const market = venue.config.markets.find((m) => m.symbol === symbol);
  if (!market) {
    recordAudit("prepare_rejected", `no venue market for ${symbol}`);
    return {
      status: 422,
      body: { error: `no venue market for ${symbol}`, listed: venue.config.markets.map((m) => m.symbol) },
    };
  }
  return { venue: venue.config, market };
}

async function loadMark(
  market: GmxMarketConfig,
  clientMark: number | undefined
): Promise<Fail | { serverMark: number }> {
  let serverMark: number;
  try {
    const feed = await getPriceFeed();
    const px = feed.prices[market.priceCoinId];
    if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) throw new Error("no mark for market");
    serverMark = px;
  } catch (err) {
    recordAudit("prepare_rejected", `no live mark available (${err instanceof Error ? err.message : "unknown"})`);
    return { status: 502, body: { error: "no live mark available — refusing to price" } };
  }
  if (clientMark !== undefined && Math.abs(clientMark - serverMark) / serverMark > MARK_DIVERGENCE_TOLERANCE) {
    recordAudit("prepare_rejected", `client mark $${clientMark} diverged >2% from server $${serverMark}`);
    return { status: 422, body: { error: "mark diverged from server feed — refresh and retry", serverMark } };
  }
  return { serverMark };
}

async function checkContracts(venue: GmxConfig, market: GmxMarketConfig): Promise<Fail | null> {
  try {
    await assertContractsDeployed(venue, market.market);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "contract check failed";
    recordAudit("prepare_rejected", `contract check failed: ${msg}`);
    return { status: 503, body: { error: msg } };
  }
}

function respond(prepared: PreparedGmxOrder, serverMark: number, extraWarnings: string[] = []) {
  return Response.json({
    ok: true,
    venue: "gmx-v2",
    serverMark,
    ...prepared,
    warnings: [
      "Review every field before sending — this moves real funds.",
      "GMX execution is async: keepers fill seconds/minutes after creation. Creation is NOT a fill — track the tx hash.",
      "If the order cannot execute at acceptablePrice it is cancelled and collateral + unused fee return to your account.",
      ...extraWarnings,
    ],
  });
}

async function prepareIncrease(
  payload: Record<string, unknown>,
  account: Address,
  clientMark: number | undefined
): Promise<Response> {
  const shape = validateOrderIntent(payload.intent);
  if (!shape.ok) {
    recordAudit("prepare_rejected", `rejected malformed intent: ${shape.error}`);
    return Response.json({ error: shape.error }, { status: 400 });
  }
  const intent: OrderIntent = shape.intent;

  const ctxRes = validateIntentContext(payload.context);
  if (!ctxRes.ok) {
    recordAudit("prepare_rejected", `rejected bad risk context: ${ctxRes.error}`);
    return Response.json({ error: ctxRes.error }, { status: 400 });
  }

  recordAudit("intent_received", `live prepare ${intent.side} ${intent.symbol} ${intent.leverage}x margin $${intent.sizeUsd}`, {
    symbol: intent.symbol,
    side: intent.side,
    sizeUsd: intent.sizeUsd,
    leverage: intent.leverage,
    account: `${account.slice(0, 10)}…`,
  });

  const caps = getRiskCaps();
  const rejection = checkCaps(intent, caps, ctxRes.context);
  if (rejection) {
    recordAudit("prepare_rejected", `blocked by caps [${rejection.code}]: ${rejection.message}`, {
      symbol: intent.symbol,
      code: rejection.code,
    });
    return Response.json({ error: rejection.message, code: rejection.code, caps }, { status: 422 });
  }
  recordAudit("intent_validated", `validated ${intent.side} ${intent.symbol} ${intent.leverage}x`, {
    symbol: intent.symbol,
  });

  const loaded = await loadMarket(intent.symbol);
  if ("status" in loaded) return Response.json(loaded.body, { status: loaded.status });
  const marked = await loadMark(loaded.market, clientMark);
  if ("status" in marked) return Response.json(marked.body, { status: marked.status });
  const contracts = await checkContracts(loaded.venue, loaded.market);
  if (contracts) return Response.json(contracts.body, { status: contracts.status });

  const quote = quoteIncrease(
    loaded.market,
    intent.side,
    intent.sizeUsd,
    intent.leverage,
    marked.serverMark,
    loaded.venue.slippageBps,
    loaded.venue.executionFeeWei
  );
  const prepared = buildIncreaseMulticall(loaded.venue, loaded.market, account, intent.side, quote);

  recordAudit("prepared", `prepared GMX ${intent.side} ${intent.symbol} ${intent.leverage}x notional $${quote.notionalUsd} @ acceptable $${quote.acceptablePriceUsd.toFixed(4)}`, {
    symbol: intent.symbol,
    side: intent.side,
    notionalUsd: quote.notionalUsd,
    serverMark: marked.serverMark,
  });
  return respond(prepared, marked.serverMark);
}

async function prepareDecrease(
  payload: Record<string, unknown>,
  account: Address,
  clientMark: number | undefined
): Promise<Response> {
  const shape = validateDecreaseIntent(payload.decrease);
  if (!shape.ok) {
    recordAudit("prepare_rejected", `rejected malformed decrease: ${shape.error}`);
    return Response.json({ error: shape.error }, { status: 400 });
  }
  const intent: DecreaseIntent = shape.intent;

  recordAudit("intent_received", `live close ${intent.side} ${intent.symbol} size $${intent.sizeDeltaUsd}`, {
    symbol: intent.symbol,
    side: intent.side,
    sizeDeltaUsd: intent.sizeDeltaUsd,
    account: `${account.slice(0, 10)}…`,
  });
  // No caps check: closing reduces exposure. Kill switch already enforced above.

  const loaded = await loadMarket(intent.symbol);
  if ("status" in loaded) return Response.json(loaded.body, { status: loaded.status });

  // Position cross-check when the indexer is readable: refuse a close that
  // exceeds the on-chain position (wrong size = failed keeper execution at
  // best). Unreadable telemetry warns but never blocks an exit.
  let positionWarning: string | null = null;
  try {
    const positions = await getVenuePositions(loaded.venue, account);
    const match = positions.find(
      (p) => p.market.toLowerCase() === loaded.market.market.toLowerCase() && p.side === intent.side
    );
    if (!match) {
      positionWarning = "No matching on-chain position found — the close may fail at execution; verify in the GMX app.";
    } else if (match.sizeUsd !== null && intent.sizeDeltaUsd - match.sizeUsd > Math.max(1, match.sizeUsd * 0.01)) {
      recordAudit("prepare_rejected", `close size $${intent.sizeDeltaUsd} exceeds on-chain $${match.sizeUsd}`);
      return Response.json(
        { error: "close size exceeds on-chain position size", onChainSizeUsd: match.sizeUsd },
        { status: 422 }
      );
    }
  } catch {
    positionWarning = "Position telemetry unreadable — proceeding unverified; confirm the position in the GMX app.";
  }

  const marked = await loadMark(loaded.market, clientMark);
  if ("status" in marked) return Response.json(marked.body, { status: marked.status });
  const contracts = await checkContracts(loaded.venue, loaded.market);
  if (contracts) return Response.json(contracts.body, { status: contracts.status });

  const quote = quoteDecrease(
    loaded.market,
    intent.side,
    intent.sizeDeltaUsd,
    intent.collateralDeltaUsd,
    marked.serverMark,
    loaded.venue.slippageBps,
    loaded.venue.executionFeeWei
  );
  const prepared = buildDecreaseMulticall(loaded.venue, loaded.market, account, intent.side, quote);

  recordAudit("intent_validated", `validated close ${intent.side} ${intent.symbol} $${intent.sizeDeltaUsd}`, {
    symbol: intent.symbol,
  });
  recordAudit("prepared", `prepared GMX close ${intent.side} ${intent.symbol} $${intent.sizeDeltaUsd} @ acceptable $${quote.acceptablePriceUsd.toFixed(4)}`, {
    symbol: intent.symbol,
    side: intent.side,
    sizeDeltaUsd: intent.sizeDeltaUsd,
    serverMark: marked.serverMark,
  });
  return respond(prepared, marked.serverMark, positionWarning ? [positionWarning] : []);
}
