"use client";

import { useCallback, useEffect, useState } from "react";
import type { RiskCaps } from "@/lib/risk";

interface TradingStatus {
  halted: boolean;
  reason: string | null;
  updatedAt: number | null;
  dryRun: boolean;
  caps: RiskCaps;
}

const POLL_MS = 15_000;

/**
 * Kill-switch banner + control. Polls GET /api/trading/status.
 * - Halted: full-width red banner, blocks new risk server-side (423s intents).
 * - Live: slim strip showing DRY-RUN vs ARMED state + Halt button.
 */
export default function HaltBanner() {
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const pull = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/trading/status", { signal, cache: "no-store" });
      if (!res.ok) return;
      setStatus((await res.json()) as TradingStatus);
    } catch {
      // Swallowed: banner simply keeps its last known state.
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void pull(ctrl.signal);
    const timer = setInterval(() => void pull(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [pull]);

  const flip = useCallback(
    async (halted: boolean) => {
      setBusy(true);
      try {
        const res = await fetch("/api/trading/halt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            halted,
            reason: halted ? "manual halt from UI" : undefined,
          }),
        });
        if (res.ok) setStatus((await res.json()) as TradingStatus);
      } catch {
        // Swallowed: next poll reconciles.
      } finally {
        setBusy(false);
      }
    },
    []
  );

  if (!status) return null;

  if (status.halted) {
    return (
      <div className="border-b border-flame-500/60 bg-flame-500/15 px-4 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex h-2 w-2 rounded-full bg-flame-500 anim-pulse-dot" />
          <span className="text-xs font-bold tracking-widest text-flame-400">TRADING HALTED</span>
          <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{status.reason ?? "no reason given"}</span>
          <button
            onClick={() => void flip(false)}
            disabled={busy}
            className="rounded border border-flame-500/60 px-2 py-0.5 text-[11px] font-bold text-flame-400 hover:bg-flame-500/20 disabled:opacity-50"
          >
            {busy ? "…" : "Resume"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-ink-700 bg-ink-900/60 px-4 py-1">
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex h-1.5 w-1.5 rounded-full ${status.dryRun ? "bg-gold-400" : "bg-mint-400 anim-pulse-dot"}`}
        />
        <span className="text-[10px] tracking-widest text-slate-500">
          {status.dryRun ? "DRY-RUN — orders validate only, nothing submits" : "ARMED — intents can proceed to venue"}
        </span>
        <span className="text-[10px] text-slate-600">
          cap ${status.caps.maxNotionalPerTradeUsd.toLocaleString()}/trade · {status.caps.maxLeverage}x · max{" "}
          {status.caps.maxOpenPositions} pos
        </span>
        <button
          onClick={() => void flip(true)}
          disabled={busy}
          className="ml-auto rounded border border-ink-600 px-2 py-0.5 text-[10px] font-bold text-slate-400 hover:border-flame-500/60 hover:text-flame-400 disabled:opacity-50"
        >
          {busy ? "…" : "Halt"}
        </button>
      </div>
    </div>
  );
}
