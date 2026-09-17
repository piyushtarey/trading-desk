"use client";

import { useCallback, useEffect, useState } from "react";
import { useDesk } from "@/lib/store";
import { STALE_MS } from "@/lib/engine";
import { Panel } from "@/components/ui";

interface LlmStatus {
  mode: string;
  configured: boolean;
  provider?: string;
  model?: string;
}

interface ScoutResult {
  deterministic: Array<{ symbol: string; heat: number }>;
  llm: {
    candidates: Array<{ symbol: string; score: number; bias: string; reason: string }>;
    agreement: { detTop: string[]; overlap: number; of: number };
    latencyMs: number;
  } | null;
  note?: string;
}

interface AnalystResult {
  deterministic: { final: number; signal: string };
  llm: {
    score: { score: number; signal: string; reason: string };
    agreement: { signalMatch: boolean; scoreDelta: number };
    latencyMs: number;
  } | null;
}

const clamp100 = (n: number) => Math.max(0, Math.min(100, n));

/**
 * LLM advisory panel (M4). Self-gating: renders nothing unless the server
 * reports a configured shadow/advisory model. Explicit button runs only —
 * no background calls, no auto-tickets. Model output is a labeled second
 * opinion; the deterministic scorer always stands.
 */
export default function LlmAnalystPanel() {
  const { state } = useDesk();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [scan, setScan] = useState<ScoutResult | null>(null);
  const [drill, setDrill] = useState<{ symbol: string; result: AnalystResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/llm/status", { signal: ctrl.signal, cache: "no-store" });
        if (res.ok) setStatus((await res.json()) as LlmStatus);
      } catch {
        /* offline — stay hidden */
      }
    })();
    return () => ctrl.abort();
  }, []);

  const runScan = useCallback(async () => {
    setError(null);
    setDrill(null);
    setBusy(true);
    try {
      const now = Date.now();
      const pairs = state.pairs
        .filter((p) => p.liveLastAt !== null && now - p.liveLastAt <= STALE_MS)
        .map((p) => ({
          symbol: p.symbol,
          chain: p.chain,
          change24h: p.change24h,
          volatility: p.volatility,
          liquidity: p.liquidity,
          liveAgeMs: now - (p.liveLastAt ?? now),
        }));
      if (pairs.length === 0) throw new Error("No fresh pairs — wait for the live feed.");
      const res = await fetch("/api/llm/scout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs }),
      });
      const data = (await res.json()) as ScoutResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Scan failed.");
      setScan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed.");
    } finally {
      setBusy(false);
    }
  }, [state.pairs]);

  const runDrill = useCallback(
    async (symbol: string) => {
      setError(null);
      setBusy(true);
      try {
        const pair = state.pairs.find((p) => p.symbol === symbol);
        if (!pair) throw new Error("Pair no longer in state.");
        // Same component formulas as the engine analyst (lib/engine.ts).
        const input = {
          symbol,
          momentum: clamp100((Math.abs(pair.change24h) / 8) * 100),
          liquidity: clamp100((pair.liquidity / 60_000_000) * 100),
          volatility: clamp100(60 - pair.volatility * 55),
          trend: clamp100(Math.abs(pair.change24h) * 9),
        };
        const res = await fetch("/api/llm/analyst", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });
        const data = (await res.json()) as AnalystResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Analysis failed.");
        setDrill({ symbol, result: data });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Analysis failed.");
      } finally {
        setBusy(false);
      }
    },
    [state.pairs]
  );

  if (!status || !status.configured || status.mode === "off" || status.mode === "proposing") return null;

  return (
    <Panel
      title={`LLM second opinion — ${status.provider}/${status.model}`}
      action={<span className="text-[9px] font-bold tracking-widest text-violet-400">{status.mode.toUpperCase()}</span>}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={() => void runScan()}
          disabled={busy}
          className="rounded border border-violet-400/50 px-3 py-1.5 text-xs font-bold text-violet-400 hover:bg-violet-400/10 disabled:opacity-50"
        >
          {busy ? "…" : "Scan market now"}
        </button>
        <span className="text-[11px] text-slate-500">
          Explicit runs only — no background calls. Deterministic ranking always stands.
        </span>
      </div>

      {error && (
        <div className="mt-3 rounded border border-flame-500/30 bg-flame-500/5 px-3 py-2 text-xs text-flame-400">
          {error}
        </div>
      )}

      {scan && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">
            Deterministic top: {scan.deterministic.map((d) => `${d.symbol} (${d.heat})`).join(" · ") || "—"}
          </div>
          {scan.llm ? (
            <>
              <div className="text-[10px] uppercase tracking-widest text-slate-500">
                Model overlap {scan.llm.agreement.overlap}/{scan.llm.agreement.of} · {scan.llm.latencyMs}ms
              </div>
              {scan.llm.candidates.map((c) => (
                <button
                  key={c.symbol}
                  onClick={() => void runDrill(c.symbol)}
                  className="flex w-full items-center gap-3 rounded border border-ink-700 bg-ink-850 px-3 py-2 text-left hover:border-violet-400/40"
                >
                  <span className="text-xs font-semibold text-slate-200">{c.symbol}</span>
                  <span className="text-[11px] text-violet-400">{c.score}</span>
                  <span className="text-[10px] uppercase text-slate-500">{c.bias}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{c.reason || "—"}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="text-xs text-gold-400">Model output dropped by validation — deterministic stands (see audit).</div>
          )}
          {scan.note && <div className="text-[11px] text-slate-600">{scan.note}</div>}
        </div>
      )}

      {drill && (
        <div className="mt-3 rounded border border-ink-700 bg-ink-850 px-3 py-2 text-xs">
          <div className="font-bold text-slate-200">
            {drill.symbol} — desk {drill.result.deterministic.final} ({drill.result.deterministic.signal})
            {drill.result.llm ? (
              <>
                {" "}vs model {drill.result.llm.score.score} ({drill.result.llm.score.signal})
                <span className={drill.result.llm.agreement.signalMatch ? "text-mint-400" : "text-gold-400"}>
                  {" "}{drill.result.llm.agreement.signalMatch ? "· agree" : `· disagree (Δ${drill.result.llm.agreement.scoreDelta})`}
                </span>
                {drill.result.llm.score.reason && (
                  <div className="mt-1 font-normal text-slate-500">{drill.result.llm.score.reason}</div>
                )}
              </>
            ) : (
              <span className="text-gold-400"> · model output dropped by validation</span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
