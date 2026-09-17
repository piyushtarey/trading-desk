/**
 * POST /api/orders/intent  { intent: OrderIntent, context?: IntentContext }
 *
 * M1 gate: every future live order must pass through here.
 * Pipeline: shape validation -> kill-switch check -> caps check -> audit.
 *
 * - Dry-run (default, DESK_DRY_RUN != "false"): validated intents are audited
 *   and echoed back WITHOUT submission.
 * - Live submission does not exist yet (M3 venue adapter). Non-dry-run
 *   requests that pass all gates fail closed with 501.
 */

import { NextRequest } from "next/server";
import { checkCaps, validateIntentContext, validateOrderIntent } from "@/lib/risk";
import { getHaltState, getRiskCaps, isDryRun, recordAudit } from "@/lib/server/trading";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const shape = validateOrderIntent(payload.intent);
  if (!shape.ok) {
    recordAudit("intent_rejected", `rejected malformed intent: ${shape.error}`);
    return Response.json({ error: shape.error }, { status: 400 });
  }
  const ctxRes = validateIntentContext(payload.context);
  if (!ctxRes.ok) {
    recordAudit("intent_rejected", `rejected bad risk context: ${ctxRes.error}`);
    return Response.json({ error: ctxRes.error }, { status: 400 });
  }
  const intent = shape.intent;
  const context = ctxRes.context;

  recordAudit("intent_received", `intent ${intent.side} ${intent.symbol} ${intent.leverage}x margin $${intent.sizeUsd}`, {
    symbol: intent.symbol,
    side: intent.side,
    sizeUsd: intent.sizeUsd,
    leverage: intent.leverage,
    notionalUsd: intent.sizeUsd * intent.leverage,
  });

  // Gate 1: kill switch — halting blocks NEW risk only.
  const halt = getHaltState();
  if (halt.halted) {
    recordAudit("intent_rejected", `blocked by kill switch: ${halt.reason ?? "halted"}`, { symbol: intent.symbol });
    return Response.json({ error: "trading halted", reason: halt.reason, haltedAt: halt.updatedAt }, { status: 423 });
  }

  // Gate 2: risk caps.
  const caps = getRiskCaps();
  const rejection = checkCaps(intent, caps, context);
  if (rejection) {
    recordAudit("intent_rejected", `blocked by caps [${rejection.code}]: ${rejection.message}`, {
      symbol: intent.symbol,
      code: rejection.code,
    });
    return Response.json({ error: rejection.message, code: rejection.code, caps }, { status: 422 });
  }

  recordAudit("intent_validated", `validated ${intent.side} ${intent.symbol} ${intent.leverage}x notional $${intent.sizeUsd * intent.leverage}`, {
    symbol: intent.symbol,
    side: intent.side,
    notionalUsd: intent.sizeUsd * intent.leverage,
  });

  // Gate 3: dry-run default. No venue adapter exists yet (M3) — fail closed.
  if (isDryRun()) {
    return Response.json({
      ok: true,
      dryRun: true,
      settlement: "not-configured",
      intent,
      notionalUsd: intent.sizeUsd * intent.leverage,
      caps,
      note: "Dry-run: validated and audited, nothing submitted. Set DESK_DRY_RUN=false only with a venue adapter (M3).",
    });
  }
  recordAudit("intent_rejected", "no venue adapter configured — refusing live submission", { symbol: intent.symbol });
  return Response.json({ error: "venue-adapter-not-configured" }, { status: 501 });
}
