/**
 * Server-only trading rails: env config, kill switch, audit log.
 *
 * SERVER-ONLY — never import from a "use client" module. There is no
 * `server-only` dependency in this repo, so this module throws on import
 * from the browser as a backstop (in addition to only being imported by
 * Route Handlers).
 *
 * NOTE on scale: halt state and the audit ring buffer are in-memory and
 * therefore per server instance. Fine for a single self-hosted instance;
 * move to Redis/Postgres before running multiple instances.
 */

import { appendFileSync } from "node:fs";
import { DEFAULT_CAPS, type RiskCaps } from "../risk";
import { uid } from "../rng";

if (typeof window !== "undefined") {
  throw new Error("lib/server/trading imported from client code — secrets must stay server-side");
}

// ---------- Env config ----------

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Risk caps: env overrides, sanitized, conservative defaults. */
export function getRiskCaps(): RiskCaps {
  return {
    maxNotionalPerTradeUsd: envPositiveNumber("DESK_MAX_NOTIONAL_PER_TRADE_USD", DEFAULT_CAPS.maxNotionalPerTradeUsd),
    maxLeverage: envPositiveNumber("DESK_MAX_LEVERAGE", DEFAULT_CAPS.maxLeverage),
    maxOpenPositions: envNonNegativeInt("DESK_MAX_OPEN_POSITIONS", DEFAULT_CAPS.maxOpenPositions),
    maxDailyLossUsd: envPositiveNumber("DESK_MAX_DAILY_LOSS_USD", DEFAULT_CAPS.maxDailyLossUsd),
  };
}

/**
 * Dry-run defaults to TRUE — the live path submits nothing unless explicitly
 * enabled with DESK_DRY_RUN=false (and even then, only via a venue adapter,
 * which does not exist yet — see M3).
 */
export function isDryRun(): boolean {
  return process.env.DESK_DRY_RUN !== "false";
}

/**
 * Live venue orders (M3 prepare/track flow) default OFF. Enable only on a
 * testnet first, with venue addresses verified — see docs/OPERATIONS.md.
 */
export function isLiveOrdersEnabled(): boolean {
  return process.env.DESK_LIVE_ORDERS_ENABLED === "true";
}

// ---------- Kill switch ----------

interface HaltState {
  halted: boolean;
  reason: string | null;
  updatedAt: number | null;
}

const halt: HaltState = {
  // Fail closed on boot when configured.
  halted: process.env.DESK_TRADING_HALTED === "true",
  reason: process.env.DESK_TRADING_HALTED === "true" ? "DESK_TRADING_HALTED=true on boot" : null,
  updatedAt: process.env.DESK_TRADING_HALTED === "true" ? Date.now() : null,
};

export function getHaltState(): HaltState {
  return { ...halt };
}

/** Halting only ever blocks NEW risk — it never closes positions by itself. */
export function setHalted(halted: boolean, reason: string | null): HaltState {
  halt.halted = halted;
  halt.reason = halted ? reason?.slice(0, 280) || "manual halt" : null;
  halt.updatedAt = Date.now();
  return getHaltState();
}

// ---------- Audit log ----------

export type AuditKind =
  | "intent_received"
  | "intent_validated"
  | "intent_rejected"
  | "prepared"
  | "prepare_rejected"
  | "llm_run"
  | "llm_rejected"
  | "halt"
  | "resume";

export interface AuditEntry {
  id: string;
  at: number;
  kind: AuditKind;
  summary: string;
  data?: Record<string, unknown>;
}

const MAX_AUDIT_ENTRIES = 500;
const auditRing: AuditEntry[] = [];

/**
 * Append-only audit record. Writes to (1) in-memory ring, (2) structured
 * stdout line, (3) JSONL file when DESK_AUDIT_LOG_PATH is set.
 * Never pass secrets, keys, or full signatures — truncate identifiers.
 */
export function recordAudit(kind: AuditKind, summary: string, data?: Record<string, unknown>): AuditEntry {
  const entry: AuditEntry = { id: uid("audit"), at: Date.now(), kind, summary, data };
  auditRing.push(entry);
  if (auditRing.length > MAX_AUDIT_ENTRIES) auditRing.splice(0, auditRing.length - MAX_AUDIT_ENTRIES);

  // Structured stdout — the durable trail when no file path is configured.
  console.log(JSON.stringify({ scope: "desk-audit", ...entry }));

  const path = process.env.DESK_AUDIT_LOG_PATH;
  if (path) {
    try {
      appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.error(`[desk-audit] file append failed (${path}): ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  return entry;
}

export function listAudit(limit = 100): AuditEntry[] {
  const n = Math.max(1, Math.min(limit, MAX_AUDIT_ENTRIES));
  return auditRing.slice(-n).reverse();
}
