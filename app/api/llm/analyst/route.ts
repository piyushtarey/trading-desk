/**
 * POST /api/llm/analyst  { input: { symbol, momentum, liquidity, volatility, trend } }
 *
 * Deterministic score always; model second opinion only in shadow/advisory,
 * validated strictly. Mode off/proposing -> 403 (same policy as scout).
 */

import { NextRequest } from "next/server";
import { ANALYST_PROMPT_VERSION, describeLlm, getLlmConfig } from "@/lib/server/llm/config";
import { callLlm, extractJson } from "@/lib/server/llm/providers";
import {
  analystAgreement,
  analystPrompt,
  deterministicAnalyst,
  validateAnalystInput,
  validateAnalystOutput,
  type LlmAnalystScore,
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
  const parsed = validateAnalystInput(payload.input);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const det = deterministicAnalyst(parsed.value);
  const meta = describeLlm(cfg.config);

  let llm: { score: LlmAnalystScore; agreement: ReturnType<typeof analystAgreement>; latencyMs: number; retried: boolean } | null = null;
  try {
    const res = await callLlm(cfg.config, analystPrompt(parsed.value, det));
    const json = extractJson(res.text);
    if (!json.ok) throw new Error(json.error);
    const valid = validateAnalystOutput(json.value);
    if (!valid.ok) throw new Error(valid.error);
    llm = {
      score: valid.score,
      agreement: analystAgreement(det, valid.score),
      latencyMs: res.latencyMs,
      retried: res.retried,
    };
    recordAudit("llm_run", `analyst ${ANALYST_PROMPT_VERSION} ${meta.provider}/${meta.model} ${llm.latencyMs}ms ${parsed.value.symbol} det ${det.final}/${det.signal} vs llm ${valid.score.score}/${valid.score.signal}`, {
      promptVersion: ANALYST_PROMPT_VERSION,
      provider: meta.provider,
      model: meta.model,
      latencyMs: llm.latencyMs,
      retried: llm.retried,
      symbol: parsed.value.symbol,
      deterministic: det,
      modelScore: { score: valid.score.score, signal: valid.score.signal },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    recordAudit("llm_rejected", `analyst model output dropped: ${msg}`, { promptVersion: ANALYST_PROMPT_VERSION });
  }

  return Response.json({
    ok: true,
    mode,
    promptVersion: ANALYST_PROMPT_VERSION,
    symbol: parsed.value.symbol,
    deterministic: det,
    llm,
  });
}
