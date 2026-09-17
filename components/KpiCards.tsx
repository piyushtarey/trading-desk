"use client";

import { useEffect, useRef, useState } from "react";
import { useDesk } from "@/lib/store";
import { realizedPnl, winRate } from "@/lib/desk";
import { fmtPct, fmtUsd } from "@/lib/format";

function useCountUp(value: number, duration = 600) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(from + (to - from) * eased);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return display;
}

function useFlash(value: number) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (value > prev.current) setFlash("up");
    else if (value < prev.current) setFlash("down");
    prev.current = value;
    const t = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [value]);
  return flash;
}

function Kpi({
  label,
  value,
  sub,
  tone,
  flash,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down" | "neutral";
  flash?: "up" | "down" | null;
}) {
  return (
    <div
      className={`rounded-lg border border-ink-700 bg-ink-900 p-4 ${
        flash === "up" ? "anim-flash-green" : flash === "down" ? "anim-flash-red" : ""
      }`}
    >
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold tabular-nums ${
          tone === "up" ? "text-mint-400" : tone === "down" ? "text-flame-400" : "text-slate-100"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function KpiCards() {
  const { state } = useDesk();

  const realized = realizedPnl(state.trades);
  const unrealized = state.positions.reduce((a, p) => a + p.pnl, 0);
  const totalPnl = realized + unrealized;

  const sells = state.trades.filter((t) => t.side === "sell");

  const executed = state.trades.filter((t) => t.side === "buy").length;
  const wr = winRate(state.trades);

  const pnlFlash = useFlash(totalPnl);
  const pnlValue = useCountUp(totalPnl);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label="Total P&L"
        value={fmtUsd(pnlValue, { sign: true })}
        sub={`${fmtUsd(realized, { sign: true })} realized · ${fmtUsd(unrealized, { sign: true })} open`}
        tone={totalPnl >= 0 ? "up" : "down"}
        flash={pnlFlash}
      />
      <Kpi label="Win rate" value={`${wr.toFixed(1)}%`} sub="closed paper trades" tone={wr >= 50 ? "up" : "down"} />
      <Kpi label="Opportunities" value={String(state.opportunities.length)} sub={`${state.opportunities.filter((o) => o.status === "pending").length} pending review`} />
      <Kpi label="Trades executed" value={String(executed)} sub={`${sells.length} closed · ${state.positions.length} open`} />
    </div>
  );
}
