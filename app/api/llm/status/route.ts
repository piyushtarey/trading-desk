/**
 * GET /api/llm/status -> { mode, configured, provider?, model?, promptVersions? }
 * Non-secret summary for UI gating. Works without a key (reports unconfigured).
 */

import { ANALYST_PROMPT_VERSION, SCOUT_PROMPT_VERSION, describeLlm, getLlmConfig } from "@/lib/server/llm/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const mode = process.env.DESK_LLM_MODE ?? "off";
  const cfg = getLlmConfig();
  if (!cfg.ok) {
    return Response.json({ mode, configured: false, reason: cfg.error });
  }
  return Response.json({
    configured: true,
    ...describeLlm(cfg.config),
    promptVersions: { scout: SCOUT_PROMPT_VERSION, analyst: ANALYST_PROMPT_VERSION },
  });
}
