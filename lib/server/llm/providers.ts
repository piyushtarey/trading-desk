/**
 * Server-only LLM provider clients (M4). Dependency-free fetch clients for
 * OpenAI (chat completions, JSON mode) and Anthropic (messages API).
 * Single attempt + one retry on 429/5xx only; timeouts enforced via AbortSignal.
 */

import type { LlmConfig } from "./config";

if (typeof window !== "undefined") {
  throw new Error("lib/server/llm imported from client code");
}

export interface LlmCall {
  system: string;
  user: string;
}

export interface LlmResult {
  text: string;
  latencyMs: number;
  retried: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Call the model and return raw text. Throws with a safe (key-free) message. */
export async function callLlm(config: LlmConfig, call: LlmCall): Promise<LlmResult> {
  const started = Date.now();
  let lastError = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text =
        config.provider === "openai"
          ? await callOpenai(config, call)
          : await callAnthropic(config, call);
      return { text, latencyMs: Date.now() - started, retried: attempt > 0 };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown";
      const retryable = /__retryable__/.test(lastError);
      if (!retryable || attempt === 1) break;
      await sleep(2000);
    }
  }
  throw new Error(`LLM call failed (${config.provider} ${config.model}): ${lastError.replace("__retryable__", "").trim()}`);
}

function markRetryable(res: Response): string {
  return RETRYABLE_STATUS.has(res.status) ? "__retryable__" : "";
}

async function callOpenai(config: LlmConfig, call: LlmCall): Promise<string> {
  const res = await postJson(
    config.apiUrl,
    { Authorization: `Bearer ${config.apiKey}` },
    {
      model: config.model,
      temperature: 0.2,
      max_tokens: config.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
    },
    config.timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${markRetryable(res)}`.trim());
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) throw new Error("empty completion");
  return content;
}

async function callAnthropic(config: LlmConfig, call: LlmCall): Promise<string> {
  const res = await postJson(
    config.apiUrl,
    { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: config.model,
      temperature: 0.2,
      max_tokens: config.maxTokens,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
    },
    config.timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${markRetryable(res)}`.trim());
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: unknown }> };
  const text = json.content?.find((b) => b.type === "text")?.text;
  if (typeof text !== "string" || text.length === 0) throw new Error("empty completion");
  return text;
}

/** Strip markdown fences and parse. Models wrap JSON in ```json blocks often. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
    .replace(/\s*```[\s\S]*$/, "")
    .trim();
  const candidate = stripped.length > 0 ? stripped : text.trim();
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown };
  } catch {
    return { ok: false, error: "model did not return parseable JSON" };
  }
}
