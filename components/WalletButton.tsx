"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useDesk } from "@/lib/store";
import { shortAddr, fmtUsd } from "@/lib/format";

const WALLET_META: Record<string, { name: string; icon: string; explorer: string; dot: string }> = {
  phantom: { name: "Phantom", icon: "👻", explorer: "https://solscan.io/account/", dot: "bg-violet-400" },
  metamask: { name: "MetaMask", icon: "🦊", explorer: "https://etherscan.io/address/", dot: "bg-gold-400" },
  demo: { name: "Demo wallet", icon: "⚡", explorer: "", dot: "bg-sky-400" },
};

export default function WalletButton() {
  const {
    kind,
    address,
    connecting,
    error,
    connect,
    disconnect,
    balance,
    balanceSymbol,
    network,
    demoFallback,
    demoBalanceUsd,
    detected,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative shrink-0" ref={ref}>
      {kind && address ? (
        <Notch
          kind={kind}
          address={address}
          balance={balance}
          balanceSymbol={balanceSymbol}
          network={network}
          demoBalanceUsd={demoBalanceUsd}
          onDisconnect={disconnect}
          open={open}
          setOpen={setOpen}
        />
      ) : (
        <div>
          <button
            onClick={() => setOpen((o) => !o)}
            disabled={connecting}
            className="rounded-md bg-gradient-to-r from-sky-400 to-violet-400 px-4 py-1.5 text-xs font-bold text-ink-950 transition-transform hover:scale-[1.03] disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
          {open && (
            <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-ink-600 bg-ink-850 p-1.5 shadow-xl">
              <WalletOption
                icon="👻"
                name="Phantom"
                installed={detected.phantom}
                onClick={() => {
                  setOpen(false);
                  void connect("phantom");
                }}
              />
              <WalletOption
                icon="🦊"
                name="MetaMask"
                installed={detected.metamask}
                onClick={() => {
                  setOpen(false);
                  void connect("metamask");
                }}
              />
              <div className="my-1 border-t border-ink-700" />
              <button
                onClick={() => {
                  setOpen(false);
                  void connect("demo");
                }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs text-slate-400 transition-colors hover:bg-ink-700 hover:text-slate-200"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-400/10">⚡</span>
                Demo wallet (no extension)
              </button>
            </div>
          )}
        </div>
      )}
      {error && <div className="absolute right-0 top-full mt-1 text-[10px] text-gold-400">{error}</div>}
      {demoFallback && !error ? (
        <div className="absolute right-0 top-full mt-1 whitespace-nowrap text-[10px] text-slate-500">
          Extension not detected — demo wallet active
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Wallet option in the connect dropdown                                 */
/* -------------------------------------------------------------------- */

function WalletOption({
  icon,
  name,
  installed,
  onClick,
}: {
  icon: string;
  name: string;
  installed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-200 transition-colors hover:bg-ink-700"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-700 text-base">{icon}</span>
      <span className="min-w-0">
        <span className="block font-semibold">{name}</span>
        <span className={`block text-[10px] ${installed ? "text-mint-400" : "text-slate-500"}`}>
          {installed ? "● installed — click to connect" : "not detected — demo fallback"}
        </span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------- */
/* Connected notch + details dropdown                                    */
/* -------------------------------------------------------------------- */

function Notch({
  kind,
  address,
  balance,
  balanceSymbol,
  network,
  demoBalanceUsd,
  onDisconnect,
  open,
  setOpen,
}: {
  kind: string;
  address: string;
  balance: number | null;
  balanceSymbol: string | null;
  network: string | null;
  demoBalanceUsd: number | null;
  onDisconnect: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { refreshBalance } = useWallet();
  const { state } = useDesk();
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const meta = WALLET_META[kind] ?? WALLET_META.demo;

  // USD estimate from the desk's own live feed (SOL/USDC, ETH/USDC pairs).
  const price =
    kind === "phantom"
      ? state.pairs.find((p) => p.id === "sol-sol")?.price
      : kind === "metamask"
        ? state.pairs.find((p) => p.id === "evm-eth")?.price
        : undefined;
  const usd =
    kind === "demo"
      ? demoBalanceUsd
      : balance != null && typeof price === "number"
        ? balance * price
        : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  }

  async function refresh() {
    setRefreshing(true);
    await refreshBalance();
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-full border border-ink-500 bg-ink-800 py-1 pl-1.5 pr-3 transition-colors hover:border-ink-400"
      >
        <span className={`flex h-6 w-6 items-center justify-center rounded-full bg-ink-700 text-sm`}>{meta.icon}</span>
        <span className="text-xs font-semibold text-slate-200">{meta.name}</span>
        {balance != null && balanceSymbol ? (
          <span className="rounded-full bg-mint-400/10 px-2 py-0.5 text-[10px] font-bold text-mint-400">
            {balance >= 1000 ? balance.toLocaleString("en-US", { maximumFractionDigits: 2 }) : balance.toFixed(4)}{" "}
            {balanceSymbol}
          </span>
        ) : kind === "demo" && demoBalanceUsd != null ? (
          <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[10px] font-bold text-sky-400">
            ${demoBalanceUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} paper
          </span>
        ) : (
          <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[10px] text-slate-500">balance…</span>
        )}
        <span className="text-[10px] text-slate-500">{network}</span>
        <span className="text-[9px] text-slate-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-ink-600 bg-ink-850 p-3 shadow-xl">
          {/* Address */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Address</div>
              <div className="truncate font-mono text-xs text-slate-200">{address}</div>
            </div>
            <button
              onClick={() => void copy()}
              className="shrink-0 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-[10px] text-slate-300 hover:border-ink-400"
            >
              {copied ? "✓ copied" : "copy"}
            </button>
          </div>

          {/* Balance */}
          <div className="mt-3 flex items-center justify-between rounded-lg bg-ink-800/60 px-3 py-2">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Balance</div>
              <div className="text-sm font-bold text-mint-400">
                {balance != null && balanceSymbol
                  ? `${balance.toFixed(4)} ${balanceSymbol}`
                  : kind === "demo"
                    ? "Paper account"
                    : "—"}
              </div>
            </div>
            {usd != null && (
              <div className="text-right">
                <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">USD</div>
                <div className="text-xs font-semibold text-slate-200">
                  ≈ {fmtUsd(usd)}
                  {kind !== "demo" && <span className="ml-1 text-[9px] font-normal text-slate-500">live</span>}
                </div>
              </div>
            )}
          </div>

          {/* Network */}
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${meta.dot}`} />
              <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Network</span>
            </div>
            <span className="text-xs text-slate-300">{network ?? "—"}</span>
          </div>

          {/* Actions */}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void refresh()}
              className="flex-1 rounded-md border border-ink-600 bg-ink-800 py-1.5 text-[10px] text-slate-300 transition-colors hover:border-ink-400"
            >
              {refreshing ? "⟳ refreshing…" : "⟳ refresh"}
            </button>
            {meta.explorer ? (
              <a
                href={meta.explorer + address}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-md border border-ink-600 bg-ink-800 py-1.5 text-center text-[10px] text-slate-300 transition-colors hover:border-ink-400"
              >
                ↗ explorer
              </a>
            ) : null}
            <button
              onClick={onDisconnect}
              className="flex-1 rounded-md border border-flame-500/30 bg-flame-500/5 py-1.5 text-[10px] text-flame-400 transition-colors hover:border-flame-500/60"
            >
              disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
