"use client";

import { useDesk } from "@/lib/store";
import { useWallet } from "@/lib/wallet";
import { Panel } from "@/components/ui";
import LiveOrderPanel from "@/components/LiveOrderPanel";
import { fmtUsd, fmtPct, fmtTime, fmtQty } from "@/lib/format";

export default function PerpsPage() {
  const { state, executePerpTicket, cancelTicket, closePerp, execError, clearExecError } = useDesk();
  const wallet = useWallet();

  // Executor signing capability: real MetaMask signature, or paper signature
  // in demo mode. A raw browser with MetaMask installed can connect+sign on click.
  const metamaskReady =
    wallet.kind === "metamask" || wallet.kind === "demo" || (wallet.kind === null && wallet.detected.metamask);

  const open = state.perpPositions.filter((p) => p.status === "open");
  const closed = state.perpPositions.filter((p) => p.status === "closed");
  const tickets = state.tickets.slice(0, 15); // newest first
  const awaiting = state.tickets.filter((t) => t.status === "proposed" && t.expiresAt > state.now).length;
  const totalMargin = open.reduce((a, p) => a + p.marginUsd, 0);
  const totalUPnl = open.reduce((a, p) => a + p.pnl, 0);
  const totalNotional = open.reduce((a, p) => a + p.notionalUsd, 0);

  return (
    <div className="mx-auto w-full max-w-none p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Perps Desk</h1>
          <p className="mt-1 text-xs text-slate-500">
            Scout spots direction → analyst builds the ticket (leverage, liq, TP/SL) → you execute with your wallet.
            Signing is a real <span className="font-semibold text-slate-300">EIP-712 eth_signTypedData_v4</span> call;
            venue routing is simulated.
          </p>
        </div>
        <div className="rounded-lg border border-gold-500/25 bg-gold-500/5 px-3 py-2 text-[10px] leading-relaxed text-gold-400">
          ⚠ Paper venue · orders are signatures only, no funds move
        </div>
      </div>

      {execError && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-flame-500/30 bg-flame-500/5 px-4 py-2 text-xs text-flame-400">
          <span>Execution failed: {execError}</span>
          <button onClick={clearExecError} className="text-[10px] text-slate-400 underline hover:text-slate-200">
            dismiss
          </button>
        </div>
      )}

      {/* KPI strip */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="OPEN PERPS" value={String(open.length)} sub={`$${fmtCompact(totalNotional)} notional`} />
        <Kpi label="MARGIN AT RISK" value={fmtUsd(totalMargin, { compact: true })} sub={`${open.length} position(s)`} />
        <Kpi
          label="OPEN P&L"
          value={`${totalUPnl >= 0 ? "+" : "−"}$${fmtCompact(Math.abs(totalUPnl))}`}
          sub="leveraged, mark-to-market"
          tone={totalUPnl >= 0 ? "mint" : "flame"}
        />
        <Kpi label="AWAITING EXECUTION" value={String(awaiting)} sub="tickets expiring in 90s" />
      </div>

      {/* LIVE VENUE ORDERS (renders only when the server exposes a configured venue) */}
      <LiveOrderPanel />

      {/* TICKET BOOK */}
      <Panel title="Ticket Book — analyst proposals" className="mt-5" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead>
              <tr className="border-b border-ink-700 text-[9px] uppercase tracking-widest text-slate-500">
                <Th>Side</Th>
                <Th>Market</Th>
                <Th>Lev</Th>
                <Th>Entry</Th>
                <Th>Margin → Notional</Th>
                <Th>Liq / TP / SL</Th>
                <Th>Conf</Th>
                <Th>Expires</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
                    No tickets yet — the analyst issues one on every BUY signal.
                  </td>
                </tr>
              )}
              {tickets.map((t) => {
                const expired = t.expiresAt <= state.now;
                const signable = t.status === "proposed" && !expired && metamaskReady;
                const secs = Math.max(0, Math.round((t.expiresAt - state.now) / 1000));
                return (
                  <tr key={t.id} className="border-b border-ink-800/60 hover:bg-ink-800/30">
                    <Td>
                      <span className={t.side === "long" ? "font-bold text-mint-400" : "font-bold text-flame-400"}>
                        {t.side === "long" ? "▲ LONG" : "▼ SHORT"}
                      </span>
                    </Td>
                    <Td>
                      <span className="font-semibold text-slate-200">{t.symbol}</span>
                      <span
                        className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold ${
                          t.chain === "solana" ? "bg-violet-400/10 text-violet-300" : "bg-sky-400/10 text-sky-300"
                        }`}
                      >
                        {t.chain === "solana" ? "SOL" : "EVM"}
                      </span>
                    </Td>
                    <Td>
                      <span className="rounded bg-gold-400/10 px-1.5 py-0.5 text-[10px] font-bold text-gold-400">
                        {t.leverage}×
                      </span>
                    </Td>
                    <Td mono>{t.entryPrice.toPrecision(6)}</Td>
                    <Td>
                      {fmtUsd(t.sizeUsd, { compact: true })} → <span className="text-slate-400">{fmtUsd(t.notionalUsd, { compact: true })}</span>
                      {t.equityUsd !== null && t.equityUsd !== undefined && t.equityUsd > 0 ? (
                        <div className="text-[9px] text-slate-600">sized off {fmtUsd(t.equityUsd, { compact: true })} eq</div>
                      ) : (
                        <div className="text-[9px] text-slate-600">fixed size (no wallet)</div>
                      )}
                    </Td>
                    <Td>
                      <span className="text-flame-400">{t.liqPrice.toPrecision(5)}</span>
                      <span className="text-slate-600"> · </span>
                      <span className="text-mint-400">{t.takeProfit.toPrecision(5)}</span>
                      <span className="text-slate-600"> · </span>
                      <span className="text-gold-400">{t.stopLoss.toPrecision(5)}</span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <div className="h-1 w-10 overflow-hidden rounded bg-ink-700">
                          <div className="h-full rounded bg-sky-400" style={{ width: `${t.confidence}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-400">{t.confidence}%</span>
                      </div>
                    </Td>
                    <Td>
                      {t.status === "proposed" && !expired ? (
                        <span className={secs <= 20 ? "font-bold text-flame-400" : "text-slate-300"}>{secs}s</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </Td>
                    <Td>
                      {t.status === "proposed" && !expired ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => void executePerpTicket(t.id)}
                            className="rounded-md bg-gradient-to-r from-sky-400 to-violet-400 px-2.5 py-1 text-[10px] font-bold text-ink-950 transition-transform hover:scale-[1.04]"
                          >
                            {wallet.kind === "metamask"
                              ? "⚡ Execute with MetaMask"
                              : wallet.kind === "demo"
                                ? "⚡ Execute (paper sign)"
                                : "⚡ Connect & sign"}
                          </button>
                          <button
                            onClick={() => cancelTicket(t.id)}
                            className="rounded-md border border-ink-600 px-1.5 py-1 text-[10px] text-slate-400 hover:border-ink-400"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <StatusChip status={t.status} />
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!metamaskReady && (
          <div className="border-t border-ink-700 px-4 py-2 text-[10px] text-slate-500">
            Connect MetaMask (or a demo wallet) in the header to enable execution — signing happens via
            eth_signTypedData_v4 on Arbitrum One.
          </div>
        )}
      </Panel>

      {/* OPEN PERPS */}
      <Panel title={`Open Perp Positions (${open.length})`} className="mt-5" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead>
              <tr className="border-b border-ink-700 text-[9px] uppercase tracking-widest text-slate-500">
                <Th>Side</Th>
                <Th>Market</Th>
                <Th>Lev</Th>
                <Th>Qty</Th>
                <Th>Entry</Th>
                <Th>Mark</Th>
                <Th>Margin</Th>
                <Th>uPnL</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {open.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
                    No open perps — execute a ticket to open one.
                  </td>
                </tr>
              )}
              {open.map((p) => (
                <tr key={p.id} className="border-b border-ink-800/60 hover:bg-ink-800/30">
                  <Td>
                    <span className={p.side === "long" ? "font-bold text-mint-400" : "font-bold text-flame-400"}>
                      {p.side === "long" ? "▲" : "▼"} {p.side}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-semibold text-slate-200">{p.symbol}</span>
                    <span className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold ${p.chain === "solana" ? "bg-violet-400/10 text-violet-300" : "bg-sky-400/10 text-sky-300"}`}>
                      {p.chain === "solana" ? "SOL" : "EVM"}
                    </span>
                  </Td>
                  <Td>
                    <span className="rounded bg-gold-400/10 px-1.5 py-0.5 text-[10px] font-bold text-gold-400">{p.leverage}×</span>
                  </Td>
                  <Td mono>{fmtQty(p.qty)}</Td>
                  <Td mono>{p.entryPrice.toPrecision(6)}</Td>
                  <Td mono>{p.markPrice.toPrecision(6)}</Td>
                  <Td>{fmtUsd(p.marginUsd, { compact: true })}</Td>
                  <Td>
                    <span className={p.pnl >= 0 ? "font-bold text-mint-400" : "font-bold text-flame-400"}>
                      {p.pnl >= 0 ? "+" : "−"}
                      {fmtUsd(Math.abs(p.pnl), { compact: true })} <span className="text-[10px]">({fmtPct(p.pnlPct, 1)})</span>
                    </span>
                  </Td>
                  <Td>
                    <button
                      onClick={() => closePerp(p.id)}
                      className="rounded-md border border-flame-500/30 bg-flame-500/5 px-2 py-1 text-[10px] text-flame-400 hover:border-flame-500/60"
                    >
                      close
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* CLOSED PERPS */}
      {closed.length > 0 && (
        <Panel title={`Closed Perps (${closed.length})`} className="mt-5" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-ink-700 text-[9px] uppercase tracking-widest text-slate-500">
                  <Th>Side</Th>
                  <Th>Market</Th>
                  <Th>Lev</Th>
                  <Th>Margin</Th>
                  <Th>Closed via</Th>
                  <Th>Realized P&L</Th>
                  <Th>Closed at</Th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 12).map((p) => (
                  <tr key={p.id} className="border-b border-ink-800/60 hover:bg-ink-800/30">
                    <Td>
                      <span className={p.side === "long" ? "text-mint-400" : "text-flame-400"}>{p.side}</span>
                    </Td>
                    <Td>
                      <span className="font-semibold text-slate-200">{p.symbol}</span>
                      <span className="ml-1.5 text-[10px] text-slate-500">{p.leverage}×</span>
                    </Td>
                    <Td>{fmtUsd(p.marginUsd, { compact: true })}</Td>
                    <Td>{p.marginUsd ? fmtUsd(p.marginUsd, { compact: true }) : "—"}</Td>
                    <Td>
                      <ViaChip via={p.closedVia} />
                    </Td>
                    <Td>
                      <span className={p.pnl >= 0 ? "font-bold text-mint-400" : "font-bold text-flame-400"}>
                        {p.pnl >= 0 ? "+" : "−"}
                        {fmtUsd(Math.abs(p.pnl), { compact: true })} ({fmtPct(p.pnlPct, 1)})
                      </span>
                    </Td>
                    <Td mono>{p.closedAt ? fmtTime(p.closedAt) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ---------------- small components ---------------- */

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "mint" | "flame" }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-3">
      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
      <div
        className={`mt-1 text-lg font-bold ${
          tone === "mint" ? "text-mint-400" : tone === "flame" ? "text-flame-400" : "text-slate-100"
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] text-slate-500">{sub}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-2 ${mono ? "font-mono text-[11px] text-slate-300" : "text-slate-300"}`}>{children}</td>;
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    signed: "bg-sky-400/10 text-sky-300",
    executed: "bg-mint-400/10 text-mint-400",
    cancelled: "bg-ink-700 text-slate-400",
    expired: "bg-gold-400/10 text-gold-400",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${map[status] ?? "bg-ink-700 text-slate-400"}`}>{status}</span>;
}

function ViaChip({ via }: { via?: string }) {
  const map: Record<string, { c: string; l: string }> = {
    "take-profit": { c: "bg-mint-400/10 text-mint-400", l: "take-profit" },
    "stop-loss": { c: "bg-gold-400/10 text-gold-400", l: "stop-loss" },
    liquidation: { c: "bg-flame-500/15 text-flame-400", l: "liquidated" },
    manual: { c: "bg-ink-700 text-slate-400", l: "manual close" },
  };
  const v = map[via ?? "manual"] ?? map.manual;
  return <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${v.c}`}>{v.l}</span>;
}

function fmtCompact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
