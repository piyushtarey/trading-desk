/**
 * Server-only LLM configuration (M4). Keys never leave the server: this module
 * exposes the key only to providers.ts in the same process, and status
 * responses carry provider/model/mode — never secrets.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/server/llm imported from client code");
}

export type LlmProvider = "openai" | "anthropic";
/**
 * off: routes 403. shadow: runs the model, logs agreement, deterministic wins.
 * advisory: same as shadow + UI may show model output labeled as such.
 * proposing: reserved — creating tickets from model output is NOT implemented
 * and routes refuse it (fail closed until M4-exit criteria are met).
 */
export type LlmMode = "off" | "shadow" | "advisory" | "proposing";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
  maxTokens: number;
  mode: LlmMode;
}

export const SCOUT_PROMPT_VERSION = "scout-v1";
export const ANALYST_PROMPT_VERSION = "analyst-v1";

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export type LlmConfigResult = { ok: true; config: LlmConfig } | { ok: false; error: string };

/** Parse + validate LLM env. Fails closed with the reason — never throws. */
export function getLlmConfig(): LlmConfigResult {
  const provider = process.env.DESK_LLM_PROVIDER ?? "openai";
  if (provider !== "openai" && provider !== "anthropic") {
    return { ok: false, error: 'DESK_LLM_PROVIDER must be "openai" or "anthropic"' };
  }
  const apiKey = process.env.DESK_LLM_API_KEY;
  if (!apiKey) return { ok: false, error: "DESK_LLM_API_KEY missing" };
  const mode = process.env.DESK_LLM_MODE ?? "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "advisory" && mode !== "proposing") {
    return { ok: false, error: 'DESK_LLM_MODE must be off|shadow|advisory|proposing' };
  }
  const defaultUrl =
    provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.anthropic.com/v1/messages";
  return {
    ok: true,
    config: {
      provider,
      model: process.env.DESK_LLM_MODEL || DEFAULT_MODELS[provider],
      apiKey,
      apiUrl: process.env.DESK_LLM_API_URL || defaultUrl,
      timeoutMs: envInt("DESK_LLM_TIMEOUT_MS", 25_000, 5_000, 120_000),
      maxTokens: envInt("DESK_LLM_MAX_TOKENS", 800, 100, 4000),
      mode,
    },
  };
}

/** Non-secret summary for status responses and logs. */
export function describeLlm(config: LlmConfig): { provider: LlmProvider; model: string; mode: LlmMode } {
  return { provider: config.provider, model: config.model, mode: config.mode };
}
