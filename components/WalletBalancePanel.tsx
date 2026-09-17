"use client";

import { useDesk } from "@/lib/store";
import { useWallet } from "@/lib/wallet";
import { accountEquityUsd } from "@/lib/account";
import { fmtUsd, shortAddr } from "@/lib/format";
import { Panel } from "@/components/ui";

const KIND_META = {
  phantom: { name: "Phantom", icon: "👻" },
  metamask: { name: "MetaMask", icon: "🦊" },
  demo: { name: "Demo wallet", icon: "⚡" },
} as const;

/**
 * Dashboard wallet strip: the connected wallet's actual native balance plus
 * its USD estimate from the desk's own live feed — the same equity number
 * the analyst uses to size ticket margins (0.5–2.5% of equity per ticket).
 */
export default function WalletBalancePanel() {
  const { state } = useDesk();
  const wallet = useWallet();
  const { kind, address, balance, balanceSymbol, network, demoBalanceUsd } = wallet;

  if (!kind || !address) {
    return (
      <Panel title="Wallet balance">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span>No wallet connected — connect Phantom or MetaMask (header, top right) for live balances.</span>
          <span className="text-slate-600">Ticket margins fall back to fixed sizing until then.</span>
        </div>
      </Panel>
    );
  }

  const meta = KIND_META[kind];
  const equity = accountEquityUsd({ kind, balance, demoBalanceUsd }, state.pairs);
  const native =
    balance !== null && balanceSymbol
      ? `${balance >= 1000 ? balance.toLocaleString("en-US", { maximumFractionDigits: 2 }) : balance.toFixed(4)} ${balanceSymbol}`
      : null;

  return (
    <Panel
      title="Wallet balance"
      action={<span className="text-[9px] tracking-widest text-slate-500">{network}</span>}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Account</div>
          <div className="mt-1 text-sm font-bold text-slate-100">
            {meta.icon} {shortAddr(address)}
          </div>
          <div className="text-[10px] text-slate-500">{meta.name}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Balance</div>
          <div className="mt-1 text-sm font-bold text-slate-100">{native ?? "…"}</div>
          <div className="text-[10px] text-slate-500">native · live feed</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Est. value</div>
          <div className="mt-1 text-sm font-bold text-mint-400">
            {equity !== null ? fmtUsd(equity) : "…"}
          </div>
          <div className="text-[10px] text-slate-500">drives ticket sizing</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Risk per ticket</div>
          <div className="mt-1 text-sm font-bold text-slate-100">0.5–2.5%</div>
          <div className="text-[10px] text-slate-500">of equity, conf-scaled</div>
        </div>
      </div>
    </Panel>
  );
}
