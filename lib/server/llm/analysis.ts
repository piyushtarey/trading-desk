/**
 * Server-only LLM analysis (M4): versioned prompts, strict validators, and
 * deterministic-vs-model agreement. The deterministic scorer is always
 * computed; model output is validated and can only ever annotate it —
 * never replace it (proposing mode is refused at the route layer).
 */

import { ANALYST_PROMPT_VERSION, SCOUT_PROMPT_VERSION } from "./config";
import { clampScore } from "../../desk";

if (typeof window !== "undefined") {
  throw new Error("lib/server/llm imported from client code");
}

// ---------- Shared sanitizers ----------

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Display-only model text: strip control chars, trim, hard cap. */
export function sanitizeReason(raw: unknown, maxLen = 280): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLen);
}

export function isSymbol(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(s);
}

// ---------- Scout ----------

export interface ScoutPairInput {
  symbol: string;
  chain: "solana" | "evm";
  change24h: number;
  volatility: number; // 0..1
  liquidity: number; // USD, >= 0
  liveAgeMs: number; // ms since last live blend
}

export interface ScoutCandidate {
  symbol: string;
  heat: number; // deterministic 0..~1.5
}

export interface LlmScoutCandidate {
  symbol: string;
  score: number; // 0..100 clamped
  bias: "long" | "short";
  reason: string; // sanitized, display-only
}

export function validateScoutInput(input: unknown): { ok: true; pairs: ScoutPairInput[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "pairs must be an array" };
  if (input.length === 0) return { ok: false, error: "pairs must be non-empty" };
  if (input.length > 20) return { ok: false, error: "pairs capped at 20 per call (cost guard)" };
  const pairs: ScoutPairInput[] = [];
  for (let i = 0; i < input.length; i++) {
    const v = (input[i] ?? {}) as Record<string, unknown>;
    if (!isSymbol(v.symbol)) return { ok: false, error: `pairs[${i}].symbol invalid` };
    if (v.chain !== "solana" && v.chain !== "evm") return { ok: false, error: `pairs[${i}].chain invalid` };
    if (!isFiniteNumber(v.change24h)) return { ok: false, error: `pairs[${i}].change24h invalid` };
    if (!isFiniteNumber(v.volatility) || v.volatility < 0 || v.volatility > 1) {
      return { ok: false, error: `pairs[${i}].volatility must be 0..1` };
    }
    if (!isFiniteNumber(v.liquidity) || v.liquidity < 0) return { ok: false, error: `pairs[${i}].liquidity invalid` };
    if (!isFiniteNumber(v.liveAgeMs) || v.liveAgeMs < 0) return { ok: false, error: `pairs[${i}].liveAgeMs invalid` };
    pairs.push({
      symbol: v.symbol,
      chain: v.chain,
      change24h: v.change24h,
      volatility: v.volatility,
      liquidity: v.liquidity,
      liveAgeMs: v.liveAgeMs,
    });
  }
  return { ok: true, pairs };
}

/** Deterministic heat — same formula as the engine scout. */
export function deterministicScout(pairs: ScoutPairInput[]): ScoutCandidate[] {
  return pairs
    .map((p) => ({ symbol: p.symbol, heat: Math.round((Math.abs(p.change24h) / 8 + p.volatility * 0.5) * 100) / 100 }))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 5);
}

export function scoutPrompt(pairs: ScoutPairInput[]): { system: string; user: string } {
  const lines = pairs
    .map(
      (p) =>
        `- ${p.symbol} (${p.chain}): 24h ${p.change24h.toFixed(2)}%, volatility ${p.volatility.toFixed(2)}, liquidity $${Math.round(p.liquidity).toLocaleString()}, data age ${(p.liveAgeMs / 1000).toFixed(0)}s`
    )
    .join("\n");
  return {
    system: `You are a crypto market scanner assisting a trading desk. Rank momentum candidates from the snapshot. Respond with JSON ONLY, no other text: {"candidates": [{"symbol": "BASE/QUOTE", "score": 0-100, "bias": "long"|"short", "reason": " under 140 chars"}]}. At most 5 candidates, symbols exactly as given. No trading advice, no position sizing.`,
    user: `Market snapshot (${SCOUT_PROMPT_VERSION}):\n${lines}`,
  };
}

/** Strict: any violation rejects the whole model output (deterministic stands). */
export function validateScoutOutput(value: unknown, known: Set<string>): { ok: true; candidates: LlmScoutCandidate[] } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "output must be an object" };
  const list = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(list)) return { ok: false, error: "output.candidates must be an array" };
  if (list.length > 5) return { ok: false, error: "output.candidates capped at 5" };
  const candidates: LlmScoutCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const v = (list[i] ?? {}) as Record<string, unknown>;
    if (!isSymbol(v.symbol) || !known.has(v.symbol)) {
      return { ok: false, error: `candidates[${i}].symbol unknown or invalid` };
    }
    if (seen.has(v.symbol)) return { ok: false, error: `candidates[${i}].symbol duplicated` };
    seen.add(v.symbol);
    if (!isFiniteNumber(v.score)) return { ok: false, error: `candidates[${i}].score invalid` };
    if (v.bias !== "long" && v.bias !== "short") return { ok: false, error: `candidates[${i}].bias invalid` };
    candidates.push({
      symbol: v.symbol,
      score: clampScore(v.score),
      bias: v.bias,
      reason: sanitizeReason(v.reason, 140),
    });
  }
  return { ok: true, candidates };
}

export function scoutAgreement(det: ScoutCandidate[], llm: LlmScoutCandidate[]): { detTop: string[]; overlap: number; of: number } {
  const detSet = new Set(det.map((d) => d.symbol));
  return {
    detTop: det.map((d) => d.symbol),
    overlap: llm.filter((c) => detSet.has(c.symbol)).length,
    of: llm.length,
  };
}

// ---------- Analyst ----------

export interface AnalystInput {
  symbol: string;
  momentum: number;
  liquidity: number;
  volatility: number; // higher = calmer (engine semantics)
  trend: number;
}

export interface DeterministicScore {
  final: number;
  signal: "BUY" | "WATCH" | "SKIP";
}

export interface LlmAnalystScore {
  score: number;
  signal: "BUY" | "WATCH" | "SKIP";
  reason: string;
}

export function validateAnalystInput(input: unknown): { ok: true; value: AnalystInput } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "input must be an object" };
  const v = input as Record<string, unknown>;
  if (!isSymbol(v.symbol)) return { ok: false, error: "symbol invalid" };
  for (const k of ["momentum", "liquidity", "volatility", "trend"] as const) {
    if (!isFiniteNumber(v[k])) return { ok: false, error: `${k} must be a finite number` };
  }
  // Clamp (don't reject): these come from our own engine, out-of-range is noise.
  const clamp100 = (n: number) => Math.max(0, Math.min(100, n));
  return {
    ok: true,
    value: {
      symbol: v.symbol,
      momentum: clamp100(v.momentum as number),
      liquidity: clamp100(v.liquidity as number),
      volatility: clamp100(v.volatility as number),
      trend: clamp100(v.trend as number),
    },
  };
}

/** Deterministic scorer — same weights + thresholds as the engine analyst. */
export function deterministicAnalyst(input: AnalystInput): DeterministicScore {
  const final = clampScore(input.momentum * 0.34 + input.liquidity * 0.22 + input.volatility * 0.18 + input.trend * 0.26 + 14);
  return { final, signal: final >= 62 ? "BUY" : final >= 44 ? "WATCH" : "SKIP" };
}

export function analystPrompt(input: AnalystInput, det: DeterministicScore): { system: string; user: string } {
  return {
    system: `You are a crypto trade analyst assisting a trading desk. Give a second opinion as JSON ONLY, no other text: {"score": 0-100, "signal": "BUY"|"WATCH"|"SKIP", "reason": "under 140 chars"}. Scores: BUY >= 62, WATCH >= 44, else SKIP. No trading advice, no position sizing.`,
    user: `Setup (${ANALYST_PROMPT_VERSION}): ${input.symbol} — momentum ${input.momentum.toFixed(0)}, liquidity ${input.liquidity.toFixed(0)}, calmness ${input.volatility.toFixed(0)}, trend ${input.trend.toFixed(0)}. Desk scorer: ${det.final} (${det.signal}). Your independent score?`,
  };
}

export function validateAnalystOutput(value: unknown): { ok: true; score: LlmAnalystScore } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "output must be an object" };
  const v = value as Record<string, unknown>;
  if (!isFiniteNumber(v.score)) return { ok: false, error: "score invalid" };
  if (v.signal !== "BUY" && v.signal !== "WATCH" && v.signal !== "SKIP") {
    return { ok: false, error: "signal must be BUY|WATCH|SKIP" };
  }
  return {
    ok: true,
    score: { score: clampScore(v.score), signal: v.signal, reason: sanitizeReason(v.reason, 140) },
  };
}

export function analystAgreement(det: DeterministicScore, llm: LlmAnalystScore): { signalMatch: boolean; scoreDelta: number } {
  return { signalMatch: det.signal === llm.signal, scoreDelta: Math.abs(det.final - llm.score) };
}
