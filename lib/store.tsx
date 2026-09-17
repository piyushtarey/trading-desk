"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DeskState } from "./desk";
import type { AgentEvent, PerpPosition } from "./types";
import { TICK_MS, createAgentRuntimes, createJobs } from "./desk";
import { createMarket } from "./market";
import { seedHistory } from "./seed";
import { runTick, closePerpPosition } from "./engine";
import { applyLivePrices, type PriceFeed } from "./prices";
import { uid } from "./rng";
import { useWallet } from "./wallet";

function createInitialState(now: number): DeskState {
  const pairs = createMarket(now);
  const seeded = seedHistory(now, pairs);
  return {
    running: true,
    tick: 0,
    now,
    pairs,
    opportunities: seeded.opportunities,
    analyses: seeded.analyses,
    positions: seeded.positions,
    trades: seeded.trades,
    events: seeded.events,
    agents: createAgentRuntimes(now),
    jobs: createJobs(now),
    startedAt: now,
    marketSource: "sim",
    lastLiveAt: null,
    tickets: seeded.tickets,
    perpPositions: seeded.perpPositions,
  };
}

const POLL_MS = 15_000;

interface DeskContextValue {
  state: DeskState;
  toggleRunning: () => void;
  toggleJob: (jobId: string) => void;
  runJobNow: (jobId: string) => void;
  /** Sign a proposed perp ticket with the connected wallet and open the position. */
  executePerpTicket: (ticketId: string) => Promise<void>;
  cancelTicket: (ticketId: string) => void;
  closePerp: (positionId: string) => void;
  execError: string | null;
  clearExecError: () => void;
}

const DeskContext = createContext<DeskContextValue | null>(null);

export function DeskProvider({ children }: { children: React.ReactNode }) {
  // Simulation state is created client-side only: it is full of random values
  // and live timestamps, which would otherwise cause SSR hydration mismatches.
  const [state, setState] = useState<DeskState | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const { signPerpOrder } = useWallet();

  useEffect(() => {
    setState(createInitialState(Date.now()));
  }, []);

  const toggleRunning = useCallback(() => {
    setState((s) => (s ? { ...s, running: !s.running } : s));
  }, []);

  const toggleJob = useCallback((jobId: string) => {
    setState((s) =>
      s
        ? {
            ...s,
            jobs: s.jobs.map((j) =>
              j.id === jobId ? { ...j, paused: !j.paused, nextRunAt: j.paused ? Date.now() + 5_000 : j.nextRunAt } : j
            ),
          }
        : s
    );
  }, []);

  const runJobNow = useCallback((jobId: string) => {
    setState((s) =>
      s ? { ...s, jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, nextRunAt: Date.now() } : j)) } : s
    );
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
  // On failure the desk keeps simulating; the ticker badge degrades LIVE -> STALE -> SIM.
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
        // Swallowed on purpose: simulation continues, badge shows staleness.
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
        runTick(next);
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const value = useMemo<DeskContextValue | null>(
    () =>
      state
        ? { state, toggleRunning, toggleJob, runJobNow, executePerpTicket, cancelTicket, closePerp, execError, clearExecError }
        : null,
    [state, toggleRunning, toggleJob, runJobNow, executePerpTicket, cancelTicket, closePerp, execError, clearExecError]
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
        <div className="mt-1 text-[10px] text-slate-600">seeding 48h of agent history · starting simulation</div>
      </div>
    </div>
  );
}

export function useDesk() {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used within DeskProvider");
  return ctx;
}
