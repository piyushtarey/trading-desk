/**
 * POST /api/llm/scout  { pairs: ScoutPairInput[] }
 *
 * Deterministic heat ranking always; model ranking only in shadow/advisory,
 * validated strictly (any violation -> model output dropped, logged).
 * Mode off -> 403. Mode proposing -> 403 (ticket creation from model output
 * is not implemented — fail closed until M4-exit criteria are met).
 */

import { NextRequest } from "next/server";
import { describeLlm, getLlmConfig, SCOUT_PROMPT_VERSION } from "@/lib/server/llm/config";
import { callLlm, extractJson } from "@/lib/server/llm/providers";
import {
  deterministicScout,
  scoutAgreement,
  scoutPrompt,
  validateScoutInput,
  validateScoutOutput,
  type LlmScoutCandidate,
} from "@/lib/server/llm/analysis";
import { recordAudit } from "@/lib/server/trading";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cfg = getLlmConfig();
  if (!cfg.ok) {
    return Response.json({ error: `llm-not-configured (${cfg.error})` }, { status: 503 });
  }
  const { mode } = cfg.config;
  if (mode === "off") return Response.json({ error: "llm disabled (DESK_LLM_MODE=off)" }, { status: 403 });
  if (mode === "proposing") {
    return Response.json({ error: "proposing not enabled — model output cannot create tickets yet" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const parsed = validateScoutInput(payload.pairs);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const pairs = parsed.pairs;

  const det = deterministicScout(pairs);
  const meta = describeLlm(cfg.config);

  let llm: {
    candidates: LlmScoutCandidate[];
    agreement: ReturnType<typeof scoutAgreement>;
    latencyMs: number;
    retried: boolean;
  } | null = null;
  try {
    const call = scoutPrompt(pairs);
    const res = await callLlm(cfg.config, call);
    const json = extractJson(res.text);
    if (!json.ok) throw new Error(json.error);
    const valid = validateScoutOutput(json.value, new Set(pairs.map((p) => p.symbol)));
    if (!valid.ok) throw new Error(valid.error);
    llm = {
      candidates: valid.candidates,
      agreement: scoutAgreement(det, valid.candidates),
      latencyMs: res.latencyMs,
      retried: res.retried,
    };
    recordAudit("llm_run", `scout ${SCOUT_PROMPT_VERSION} ${meta.provider}/${meta.model} ${llm.latencyMs}ms overlap ${llm.agreement.overlap}/${llm.agreement.of}`, {
      promptVersion: SCOUT_PROMPT_VERSION,
      provider: meta.provider,
      model: meta.model,
      latencyMs: llm.latencyMs,
      retried: llm.retried,
      candidates: valid.candidates.map((c) => ({ symbol: c.symbol, score: c.score, bias: c.bias })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    recordAudit("llm_rejected", `scout model output dropped: ${msg}`, { promptVersion: SCOUT_PROMPT_VERSION });
  }

  return Response.json({
    ok: true,
    mode,
    promptVersion: SCOUT_PROMPT_VERSION,
    deterministic: det,
    llm,
    note:
      mode === "shadow"
        ? "Shadow mode: model output is logged for agreement tracking only."
        : "Advisory mode: model output is a labeled second opinion. Deterministic ranking stands.",
  });
}
