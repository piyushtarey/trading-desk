"use client";

import { useDesk } from "@/lib/store";
import { fmtPct, fmtQty, fmtUsd } from "@/lib/format";

function Price({ value }: { value: number }) {
  if (value >= 1000) return <>{value.toFixed(2)}</>;
  if (value >= 1) return <>{value.toFixed(4)}</>;
  return <>{value.toPrecision(4)}</>;
}

export default function PositionsTable() {
  const { state } = useDesk();

  if (state.positions.length === 0) {
    return <div className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-xs text-slate-500">No open positions</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-ink-700">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-ink-700 bg-ink-850 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">Chain</th>
            <th className="px-3 py-2 text-right font-medium">Entry</th>
            <th className="px-3 py-2 text-right font-medium">Mark</th>
            <th className="px-3 py-2 text-right font-medium">Size</th>
            <th className="px-3 py-2 text-right font-medium">P&L</th>
            <th className="px-3 py-2 text-right font-medium">P&L %</th>
          </tr>
        </thead>
        <tbody>
          {state.positions.map((p) => (
            <tr key={p.id} className="border-b border-ink-800 last:border-0 hover:bg-ink-850/60">
              <td className="px-3 py-2 font-semibold text-slate-200">{p.symbol}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                    p.chain === "solana" ? "bg-violet-400/15 text-violet-400" : "bg-gold-400/15 text-gold-400"
                  }`}
                >
                  {p.chain === "solana" ? "SOL" : "EVM"}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                <Price value={p.entryPrice} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-200">
                <Price value={p.markPrice} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                {fmtQty(p.qty)} · {fmtUsd(p.notionalUsd, { compact: true })}
              </td>
              <td className={`px-3 py-2 text-right font-semibold tabular-nums ${p.pnl >= 0 ? "text-mint-400" : "text-flame-400"}`}>
                {fmtUsd(p.pnl, { sign: true })}
              </td>
              <td className={`px-3 py-2 text-right tabular-nums ${p.pnlPct >= 0 ? "text-mint-400" : "text-flame-400"}`}>
                {fmtPct(p.pnlPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
