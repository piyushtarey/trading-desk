"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DeskState } from "./desk";
import type { AgentEvent, AgentId, JobKind, PerpPosition, ScheduledJob } from "./types";
import { TICK_MS, createAgentRuntimes, createJobs } from "./desk";
import { createMarket } from "./market";
import { runTick, closePerpPosition } from "./engine";
import { applyLivePrices, type PriceFeed } from "./prices";
import { accountEquityUsd } from "./account";
import { uid } from "./rng";
import { useWallet } from "./wallet";

/**
 * Boot from pair shells + empty books. The first live poll (below) anchors
 * prices; the scout starts queueing real opportunities from the first fresh
 * blend. No seeded history — an empty desk before live data is honest.
 */
function createInitialState(now: number): DeskState {
  return {
    running: true,
    tick: 0,
    now,
    pairs: createMarket(),
    opportunities: [],
    analyses: [],
    positions: [],
    trades: [],
    events: [],
    agents: createAgentRuntimes(now),
    jobs: mergeJobs(now),
    startedAt: now,
    marketSource: "sim",
    lastLiveAt: null,
    tickets: [],
    perpPositions: [],
    accountEquityUsd: null,
  };
}

const POLL_MS = 15_000;

/** Jobs persistence + bounds. Timers always restart on reload (see mergeJobs). */
const JOBS_LS_KEY = "tradingdesk.jobs.v1";
export const MIN_JOB_INTERVAL_MS = 10_000;
const MAX_JOB_INTERVAL_MS = 86_400_000;

const JOB_KINDS: JobKind[] = ["scan", "analysis", "exec", "rebalance", "risk", "heartbeat"];

function asAgent(agent: ScheduledJob["agent"]): AgentId {
  return agent === "system" ? "scout" : agent;
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_JOB_INTERVAL_MS;
  return Math.max(MIN_JOB_INTERVAL_MS, Math.min(MAX_JOB_INTERVAL_MS, Math.round(ms)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Validate one stored job; null = drop it. Corrupt payloads never break boot. */
function sanitizeStoredJob(v: unknown): ScheduledJob | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 80) return null;
  if (typeof v.kind !== "string" || !(JOB_KINDS as string[]).includes(v.kind)) return null;
  if (typeof v.name !== "string" || v.name.trim().length === 0) return null;
  const agent = v.agent;
  if (agent !== "scout" && agent !== "analyst" && agent !== "executor" && agent !== "system") return null;
  return {
    id: v.id,
    kind: v.kind as JobKind,
    builtIn: v.builtIn === true,
    agent,
    name: v.name.trim().slice(0, 60),
    description: typeof v.description === "string" ? v.description.trim().slice(0, 140) : "",
    intervalMs: clampInterval(typeof v.intervalMs === "number" ? v.intervalMs : MIN_JOB_INTERVAL_MS),
    nextRunAt: 0, // always rescheduled at boot
    lastRunAt: null,
    runCount: typeof v.runCount === "number" && Number.isInteger(v.runCount) && v.runCount >= 0 ? v.runCount : 0,
    paused: v.paused === true,
  };
}

function loadStoredJobs(): ScheduledJob[] {
  try {
    const raw = localStorage.getItem(JOBS_LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ScheduledJob[] = [];
    for (const item of parsed.slice(0, 50)) {
      const job = sanitizeStoredJob(item);
      if (job && !out.some((j) => j.id === job.id)) out.push(job);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Boot merge: stored overrides (interval/paused/name/description/runCount)
 * apply onto fresh defaults; stored custom jobs are appended. Timers always
 * restart (nextRunAt = now + interval) so a reload never fires a stale burst.
 */
function mergeJobs(now: number): ScheduledJob[] {
  const defaults = createJobs(now);
  let stored: ScheduledJob[] = [];
  try {
    stored = loadStoredJobs();
  } catch {
    stored = [];
  }
  const byId = new Map(stored.map((j) => [j.id, j]));
  const merged = defaults.map((d) => {
    const o = byId.get(d.id);
    if (!o) return d;
    return {
      ...d,
      name: o.name || d.name,
      description: o.description || d.description,
      intervalMs: o.intervalMs,
      nextRunAt: now + o.intervalMs,
      runCount: o.runCount,
      paused: o.paused,
    };
  });
  for (const o of stored) {
    if (!o.builtIn && !merged.some((j) => j.id === o.id)) {
      merged.push({ ...o, nextRunAt: now + o.intervalMs });
    }
  }
  return merged;
}

function persistJobs(jobs: ScheduledJob[]) {
  try {
    localStorage.setItem(JOBS_LS_KEY, JSON.stringify(jobs));
  } catch {
    /* storage full/blocked — jobs keep working in memory */
  }
}

function jobAudit(agent: AgentId, title: string, detail: string, payload?: Record<string, unknown>): AgentEvent {
  return { id: uid("evt"), agent, type: "job", title, detail, payload, at: Date.now() };
}

function pushJobAudit(events: AgentEvent[], e: AgentEvent): AgentEvent[] {
  return [e, ...events].slice(0, 400);
}

interface DeskContextValue {
  state: DeskState;
  toggleRunning: () => void;
  toggleJob: (jobId: string) => void;
  runJobNow: (jobId: string) => void;
  /** Change a job's interval (clamped 10s..24h, next run resets). */
  updateJobInterval: (jobId: string, intervalMs: number) => void;
  /** Rename / re-describe a job (trimmed, length-capped). */
  updateJob: (jobId: string, patch: { name?: string; description?: string }) => void;
  /** Add a custom job running an existing handler kind. Returns its id. */
  addJob: (input: { name: string; kind: JobKind; intervalMs: number }) => string | null;
  /** Delete any job (built-ins included — the engine degrades gracefully). */
  deleteJob: (jobId: string) => void;
  /** Sign a proposed perp ticket with the connected wallet and open the position. */
  executePerpTicket: (ticketId: string) => Promise<void>;
  cancelTicket: (ticketId: string) => void;
  closePerp: (positionId: string) => void;
  execError: string | null;
  clearExecError: () => void;
}

const DeskContext = createContext<DeskContextValue | null>(null);

export function DeskProvider({ children }: { children: React.ReactNode }) {
  // Desk state is created client-side only: it carries live timestamps that
  // would otherwise cause SSR hydration mismatches.
  const [state, setState] = useState<DeskState | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const { signPerpOrder, kind: walletKind, address: walletAddress, balance: walletBalance, demoBalanceUsd } = useWallet();

  useEffect(() => {
    setState(createInitialState(Date.now()));
  }, []);

  const toggleRunning = useCallback(() => {
    setState((s) => (s ? { ...s, running: !s.running } : s));
  }, []);

  const toggleJob = useCallback((jobId: string) => {
    setState((s) => {
      if (!s) return s;
      const jobs = s.jobs.map((j) =>
        j.id === jobId ? { ...j, paused: !j.paused, nextRunAt: j.paused ? Date.now() + 5_000 : j.nextRunAt } : j
      );
      persistJobs(jobs);
      return { ...s, jobs };
    });
  }, []);

  const runJobNow = useCallback((jobId: string) => {
    setState((s) => {
      if (!s) return s;
      const jobs = s.jobs.map((j) => (j.id === jobId ? { ...j, nextRunAt: Date.now() } : j));
      persistJobs(jobs);
      return { ...s, jobs };
    });
  }, []);

  const updateJobInterval = useCallback((jobId: string, intervalMs: number) => {
    const ms = clampInterval(intervalMs);
    setState((s) => {
      if (!s) return s;
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job) return s;
      const jobs = s.jobs.map((j) => (j.id === jobId ? { ...j, intervalMs: ms, nextRunAt: Date.now() + ms } : j));
      persistJobs(jobs);
      return {
        ...s,
        jobs,
        events: pushJobAudit(
          s.events,
          jobAudit(asAgent(job.agent), `Job interval: ${job.name}`, `Every ${ms / 1000}s (was ${job.intervalMs / 1000}s) · next run reset`, { jobId, intervalMs: ms })
        ),
      };
    });
  }, []);

  const updateJob = useCallback((jobId: string, patch: { name?: string; description?: string }) => {
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 60) : undefined;
    const description = patch.description !== undefined ? patch.description.trim().slice(0, 140) : undefined;
    if (name !== undefined && name.length === 0) return;
    setState((s) => {
      if (!s) return s;
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job) return s;
      const jobs = s.jobs.map((j) =>
        j.id === jobId
          ? { ...j, name: name ?? j.name, description: description ?? j.description }
          : j
      );
      persistJobs(jobs);
      return {
        ...s,
        jobs,
        events: pushJobAudit(s.events, jobAudit(asAgent(job.agent), `Job updated: ${job.name}`, name ? `Renamed to "${name}"` : "Description edited", { jobId })),
      };
    });
  }, []);

  const addJob = useCallback((input: { name: string; kind: JobKind; intervalMs: number }): string | null => {
    const name = input.name.trim().slice(0, 60);
    if (name.length === 0 || !(JOB_KINDS as string[]).includes(input.kind)) return null;
    const ms = clampInterval(input.intervalMs);
    const id = uid("job");
    const defaults: Record<JobKind, { agent: ScheduledJob["agent"]; description: string }> = {
      scan: { agent: "scout", description: "Sweep all pairs for fresh momentum & liquidity anomalies" },
      analysis: { agent: "analyst", description: "Re-score open opportunities, expire stale ones" },
      exec: { agent: "executor", description: "Pick up analyst BUY signals and paper-execute" },
      rebalance: { agent: "executor", description: "Trim positions > 20% of book, take profit > +6%" },
      risk: { agent: "analyst", description: "Check drawdown and volatility spikes across book" },
      heartbeat: { agent: "system", description: "All agents ping in, verify pipeline is alive" },
    };
    const job: ScheduledJob = {
      id,
      kind: input.kind,
      builtIn: false,
      agent: defaults[input.kind].agent,
      name,
      description: defaults[input.kind].description,
      intervalMs: ms,
      nextRunAt: Date.now() + ms,
      lastRunAt: null,
      runCount: 0,
      paused: false,
    };
    setState((s) => {
      if (!s) return s;
      const jobs = [...s.jobs, job];
      persistJobs(jobs);
      return {
        ...s,
        jobs,
        events: pushJobAudit(
          s.events,
          jobAudit(asAgent(job.agent), `Job added: ${name}`, `${input.kind} every ${ms / 1000}s`, { jobId: id, kind: input.kind })
        ),
      };
    });
    return id;
  }, []);

  const deleteJob = useCallback((jobId: string) => {
    setState((s) => {
      if (!s) return s;
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job) return s;
      const jobs = s.jobs.filter((j) => j.id !== jobId);
      persistJobs(jobs);
      const remaining = jobs.filter((j) => j.kind === job.kind).length;
      return {
        ...s,
        jobs,
        events: pushJobAudit(
          s.events,
          jobAudit(
            asAgent(job.agent),
            `Job deleted: ${job.name}`,
            remaining === 0
              ? `No ${job.kind} jobs remain — that handler is now idle`
              : `${remaining} ${job.kind} job(s) still scheduled`,
            { jobId, kind: job.kind }
          )
        ),
      };
    });
  }, []);

  const clearExecError = useCallback(() => setExecError(null), []);

  const cancelTicket = useCallback((ticketId: string) => {
    setState((s) =>
      s
        ? {
            ...s,
            tickets: s.tickets.map((t) => (t.id === ticketId && t.status === "proposed" ? { ...t, status: "cancelled" } : t)),
          }
        : s
    );
  }, []);

  const closePerp = useCallback((positionId: string) => {
    setState((s) => {
      if (!s) return s;
      const next: DeskState = {
        ...s,
        perpPositions: s.perpPositions.map((p) => ({ ...p })),
        events: s.events.slice(),
      };
      closePerpPosition(next, positionId, "manual");
      return next;
    });
  }, []);

  const executePerpTicket = useCallback(
    async (ticketId: string) => {
      // M6: paper ticket execution lives only in the dev harness. Production
      // flow is the venue panel (prepare -> wallet send -> track).
      if (process.env.NEXT_PUBLIC_DESK_PAPER_MODE !== "true") {
        setExecError("Paper tickets are disabled — use Live orders above for venue execution");
        return;
      }
      const s = state;
      if (!s) return;
      const t = s.tickets.find((x) => x.id === ticketId);
      if (!t || t.status !== "proposed" || t.expiresAt <= Date.now()) return;

      // Reserve immediately so the row can't be double-fired while the popup is open.
      setState((prev) =>
        prev
          ? { ...prev, tickets: prev.tickets.map((x) => (x.id === ticketId ? { ...x, status: "signed" as const } : x)) }
          : prev
      );

      try {
        const { signature, signer } = await signPerpOrder(t);
        setState((prev) => {
          if (!prev) return prev;
          const tk = prev.tickets.find((x) => x.id === ticketId);
          if (!tk) return prev;
          const executed = { ...tk, status: "executed" as const, signature, signedBy: signer };

          const pair = prev.pairs.find((p) => p.symbol === t.symbol);
          const entry = pair ? pair.price : t.entryPrice;
          const qty = t.notionalUsd / entry;
          const pos: PerpPosition = {
            id: uid("pperp"),
            ticketId: t.id,
            symbol: t.symbol,
            chain: t.chain,
            side: t.side,
            qty,
            leverage: t.leverage,
            entryPrice: entry,
            markPrice: entry,
            marginUsd: t.sizeUsd,
            notionalUsd: t.notionalUsd,
            liqPrice: t.liqPrice,
            takeProfit: t.takeProfit,
            stopLoss: t.stopLoss,
            pnl: 0,
            pnlPct: 0,
            openedAt: Date.now(),
            status: "open",
          };
          const evt: AgentEvent = {
            id: uid("evt"),
            agent: "executor",
            type: "order",
            title: `EXEC PERP ${t.side.toUpperCase()} ${t.symbol} ${t.leverage}x`,
            detail: `Signed by ${signer.slice(0, 10)}… · $${t.sizeUsd.toLocaleString()} margin · notional $${t.notionalUsd.toLocaleString()} · routed to venue (simulated)`,
            payload: { ticketId: t.id, signature: signature.slice(0, 18) + "…", side: t.side, leverage: t.leverage, notionalUsd: t.notionalUsd },
            at: Date.now(),
          };

          return {
            ...prev,
            tickets: prev.tickets.map((x) => (x.id === ticketId ? executed : x)),
            perpPositions: [pos, ...prev.perpPositions],
            events: [evt, ...prev.events].slice(0, 400),
            agents: {
              ...prev.agents,
              executor: {
                ...prev.agents.executor,
                state: "executing",
                lastOutput: `Signed ${t.side} ${t.symbol} ${t.leverage}x`,
                heartbeatAt: Date.now(),
                tasksDone: prev.agents.executor.tasksDone + 1,
              },
            },
          };
        });
        setExecError(null);
      } catch (err) {
        // Signature rejected/failed — return the ticket to the proposed queue.
        setState((prev) =>
          prev
            ? { ...prev, tickets: prev.tickets.map((x) => (x.id === ticketId && x.status === "signed" ? { ...x, status: "proposed" as const } : x)) }
            : prev
        );
        const msg = err instanceof Error ? err.message : "Signature rejected";
        setExecError(msg === "Signature rejected" ? "Signature rejected in wallet" : msg);
      }
    },
    [state, signPerpOrder],
  );

  // Live prices: fetch at boot, then poll every 15s (server caches upstream 30s).
  // On failure the desk holds last live values; the ticker badge degrades
  // LIVE -> STALE -> SIM and the scout idles until the feed recovers.
  useEffect(() => {
    const ctrl = new AbortController();

    async function pull() {
      try {
        const res = await fetch("/api/prices", { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const feed = (await res.json()) as PriceFeed;
        if (!feed || typeof feed.at !== "number" || !feed.prices) throw new Error("bad payload");
        setState((s) =>
          s
            ? {
                ...s,
                pairs: applyLivePrices(s.pairs, feed, Date.now()),
                marketSource: feed.source,
                lastLiveAt: Date.now(),
              }
            : s
        );
      } catch {
        // Swallowed on purpose: last live values hold, badge shows staleness.
      }
    }

    void pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      // Snapshot wallet for equity sizing (fresh closure per wallet change).
      const wallet = { kind: walletKind, balance: walletBalance, demoBalanceUsd };
      setState((s) => {
        if (!s) return s;
        if (!s.running) return { ...s, now: Date.now() };
        // Engine mutates a shallow-cloned state in place; we always return a fresh top-level object.
        const next: DeskState = {
          ...s,
          pairs: s.pairs.map((p) => ({ ...p })),
          opportunities: s.opportunities.map((o) => ({ ...o })),
          analyses: s.analyses.slice(),
          positions: s.positions.map((p) => ({ ...p })),
          trades: s.trades.slice(),
          events: s.events.slice(),
          tickets: s.tickets.slice(),
          perpPositions: s.perpPositions.map((p) => ({ ...p })),
          agents: {
            scout: { ...s.agents.scout },
            analyst: { ...s.agents.analyst },
            executor: { ...s.agents.executor },
          },
          jobs: s.jobs.map((j) => ({ ...j })),
        };
        // Refresh wallet equity BEFORE the tick so ticket sizing uses it.
        next.accountEquityUsd = accountEquityUsd(wallet, next.pairs);
        runTick(next);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [walletKind, walletAddress, walletBalance, demoBalanceUsd]);

  const value = useMemo<DeskContextValue | null>(
    () =>
      state
        ? { state, toggleRunning, toggleJob, runJobNow, updateJobInterval, updateJob, addJob, deleteJob, executePerpTicket, cancelTicket, closePerp, execError, clearExecError }
        : null,
    [state, toggleRunning, toggleJob, runJobNow, updateJobInterval, updateJob, addJob, deleteJob, executePerpTicket, cancelTicket, closePerp, execError, clearExecError]
  );

  if (!value) return <BootScreen />;

  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

function BootScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-ink-950">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded bg-gradient-to-br from-sky-400 to-violet-400 text-lg font-bold text-ink-950 anim-glow">
          TD
        </div>
        <div className="text-sm font-bold tracking-widest text-slate-300">INITIALIZING DESK…</div>
        <div className="mt-1 text-[10px] text-slate-600">connecting to live market feed…</div>
      </div>
    </div>
  );
}

export function useDesk() {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used within DeskProvider");
  return ctx;
}
