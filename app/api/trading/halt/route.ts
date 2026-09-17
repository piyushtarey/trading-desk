/**
 * POST /api/trading/halt  { halted: boolean, reason?: string }
 * -> HaltState
 *
 * Flips the kill switch. Halting blocks NEW risk only — it never closes
 * positions by itself. Every flip is audit-logged.
 *
 * WARNING: no auth exists in this app yet. Before exposing this instance
 * beyond localhost, gate this route (and /api/audit) behind authentication.
 */

import { NextRequest } from "next/server";
import { getHaltState, recordAudit, setHalted } from "@/lib/server/trading";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof payload.halted !== "boolean") {
    return Response.json({ error: "halted must be a boolean" }, { status: 400 });
  }
  const reason = typeof payload.reason === "string" ? payload.reason : null;

  const current = getHaltState();
  if (current.halted === payload.halted) return Response.json(current);

  const next = setHalted(payload.halted, reason);
  recordAudit(
    payload.halted ? "halt" : "resume",
    payload.halted ? `TRADING HALTED: ${next.reason}` : "trading resumed",
    payload.halted ? { reason: next.reason } : undefined
  );
  return Response.json(next);
}
