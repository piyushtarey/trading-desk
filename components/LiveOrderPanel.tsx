"use client";

import { useCallback, useEffect, useState } from "react";
import { useDesk } from "@/lib/store";
import { useWallet } from "@/lib/wallet";
import { accountEquityUsd } from "@/lib/account";
import { Panel } from "@/components/ui";
import { fmtUsd } from "@/lib/format";

interface VenueMarket {
  symbol: string;
  market: string;
  indexToken: string;
  indexDecimals: number;
  longToken: string;
  shortToken: string;
  collateralToken: string;
  collateralDecimals: number;
}

interface MarketsResponse {
  venue: string;
  chainId: number;
  slippageBps: number;
  executionFeeWei: string;
  markets: VenueMarket[];
}

interface PreparedResponse {
  ok: boolean;
  venue: string;
  chainId: number;
  serverMark: number;
  tx: { to: string; data: string; value: string };
  approvals: Array<{ token: string; spender: string; amount: string; note: string }>;
  quote: {
    notionalUsd: number;
    sizeDeltaUsd: string;
    collateralAmount: string;
    acceptablePriceUsd: number;
    executionFeeEth: string;
  };
  decode: { market: string; account: string; side: string; orderType: string };
  warnings: string[];
}

type TrackStatus = "pending" | "success" | "reverted";

interface VenuePosition {
  positionKey: string;
  market: string;
  symbol: string | null;
  isLong: boolean;
  side: "long" | "short";
  sizeUsd: number | null;
  collateralUsd: number | null;
  entryPriceUsd: number | null;
  leverage: number | null;
  unrealizedPnlUsd: number | null;
  openedAt: number | null;
}

const CHAIN_NAMES: Record<number, string> = { 42161: "Arbitrum One", 421614: "Arbitrum Sepolia (testnet)" };

/**
 * Live GMX v2 order flow (M3). Self-gating: renders nothing unless the server
 * exposes a configured venue. Flow: prepare (server gates + unsigned tx) ->
 * review -> send via MetaMask -> track receipt. Creation is NOT a fill:
 * GMX keepers execute asynchronously afterwards.
 */
export default function LiveOrderPanel() {
  const { state } = useDesk();
  const wallet = useWallet();
  const [markets, setMarkets] = useState<MarketsResponse | null>(null);
  const [off, setOff] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"long" | "short">("long");
  const [margin, setMargin] = useState("100");
  const [marginTouched, setMarginTouched] = useState(false);
  const [leverage, setLeverage] = useState("3");
  const [prepared, setPrepared] = useState<PreparedResponse | null>(null);
  const [preparedLabel, setPreparedLabel] = useState<string>("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [tracked, setTracked] = useState<{ status: TrackStatus; blockNumber: number | null } | null>(null);
  const [positions, setPositions] = useState<VenuePosition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/orders/markets", { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) {
          setOff(true);
          return;
        }
        const data = (await res.json()) as MarketsResponse;
        setMarkets(data);
        if (data.markets.length > 0) setSymbol(data.markets[0].symbol);
      } catch {
        setOff(true);
      }
    })();
    return () => ctrl.abort();
  }, []);

  const reset = useCallback(() => {
    setPrepared(null);
    setPreparedLabel("");
    setTxHash(null);
    setTracked(null);
    setError(null);
  }, []);

  const refreshPositions = useCallback(async () => {
    if (wallet.kind !== "metamask" || !wallet.address) {
      setPositions(null);
      return;
    }
    try {
      const res = await fetch(`/api/positions?account=${wallet.address}`, { cache: "no-store" });
      if (!res.ok) {
        setPositions(null);
        return;
      }
      const data = (await res.json()) as { positions?: VenuePosition[] };
      setPositions(Array.isArray(data.positions) ? data.positions : []);
    } catch {
      setPositions(null);
    }
  }, [wallet.kind, wallet.address]);

  useEffect(() => {
    void refreshPositions();
  }, [refreshPositions]);

  // Suggested margin: 1% of wallet equity until the user types their own.
  const equity = accountEquityUsd(
    { kind: wallet.kind, balance: wallet.balance, demoBalanceUsd: wallet.demoBalanceUsd },
    state.pairs
  );
  const suggested = equity !== null && equity > 0 ? Math.max(50, Math.min(Math.round(equity * 0.01), 1000)) : null;
  useEffect(() => {
    if (!marginTouched && suggested !== null) setMargin(String(suggested));
  }, [suggested, marginTouched]);

  const onSymbol = useCallback(
    (s: string) => {
      setSymbol(s);
      reset();
    },
    [reset]
  );

  const deskMark = state.pairs.find((p) => p.symbol === symbol)?.price;

  const prepare = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (wallet.kind !== "metamask" || !wallet.address) {
        throw new Error("Connect MetaMask first — live orders need a real signer (demo cannot move funds).");
      }
      const sizeUsd = Number(margin);
      const lev = Number(leverage);
      if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) throw new Error("Margin must be a positive number.");
      if (!Number.isFinite(lev) || lev < 1) throw new Error("Leverage must be >= 1.");
      const res = await fetch("/api/orders/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: { symbol, side, sizeUsd, leverage: lev },
          account: wallet.address,
          markPrice: deskMark && deskMark > 0 ? deskMark : undefined,
          // Venue-derived open count; day P&L still caller-asserted until M5 derives it.
          context: { openPositions: positions?.length ?? 0, dailyRealizedPnl: 0 },
        }),
      });
      const data = (await res.json()) as PreparedResponse & { error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Prepare failed.");
      setPrepared(data);
      setPreparedLabel(`${side.toUpperCase()} ${symbol}`);
      setTxHash(null);
      setTracked(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Prepare failed.");
    } finally {
      setBusy(false);
    }
  }, [wallet.kind, wallet.address, margin, leverage, symbol, side, deskMark, positions]);

  const closePosition = useCallback(
    async (pos: VenuePosition) => {
      setError(null);
      setBusy(true);
      try {
        if (wallet.kind !== "metamask" || !wallet.address) {
          throw new Error("Connect MetaMask first — live orders need a real signer.");
        }
        if (!pos.symbol || pos.sizeUsd === null || pos.collateralUsd === null) {
          throw new Error("Position has no priced values (unknown market) — close it in the GMX app.");
        }
        const res = await fetch("/api/orders/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "decrease",
            decrease: { symbol: pos.symbol, side: pos.side, sizeDeltaUsd: pos.sizeUsd, collateralDeltaUsd: pos.collateralUsd },
            account: wallet.address,
          }),
        });
        const data = (await res.json()) as PreparedResponse & { error?: string };
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Close prepare failed.");
        setPrepared(data);
        setPreparedLabel(`CLOSE ${pos.side.toUpperCase()} ${pos.symbol}`);
        setTxHash(null);
        setTracked(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Close prepare failed.");
      } finally {
        setBusy(false);
      }
    },
    [wallet.kind, wallet.address]
  );

  const send = useCallback(async () => {
    if (!prepared) return;
    setError(null);
    setBusy(true);
    try {
      const valueHex = `0x${BigInt(prepared.tx.value).toString(16)}`;
      const hash = await wallet.sendTransaction({
        to: prepared.tx.to,
        data: prepared.tx.data,
        value: valueHex,
        chainId: prepared.chainId,
      });
      setTxHash(hash);
      setTracked(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setBusy(false);
    }
  }, [prepared, wallet]);

  const track = useCallback(async () => {
    if (!txHash) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/orders/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      });
      const data = (await res.json()) as { status?: TrackStatus; blockNumber?: number | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Track failed.");
      setTracked({ status: data.status ?? "pending", blockNumber: data.blockNumber ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Track failed.");
    } finally {
      setBusy(false);
    }
  }, [txHash]);

  if (off || !markets) return null;
  const chainName = CHAIN_NAMES[markets.chainId] ?? `chain ${markets.chainId}`;
  const isTestnet = markets.chainId !== 42161;

  return (
    <Panel
      title={`Live orders — GMX v2 · ${chainName}`}
      className="mt-5"
      action={<span className="text-[9px] font-bold tracking-widest text-flame-400">REAL FUNDS</span>}
    >
      <div className="grid gap-3 md:grid-cols-5">
        <label className="text-[11px] text-slate-400">
          Market
          <select
            value={symbol}
            onChange={(e) => onSymbol(e.target.value)}
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          >
            {markets.markets.map((m) => (
              <option key={m.symbol} value={m.symbol}>
                {m.symbol}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[11px] text-slate-400">
          Side
          <div className="mt-1 flex gap-1">
            {(["long", "short"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  setSide(s);
                  reset();
                }}
                className={`flex-1 rounded border px-2 py-1.5 text-xs font-bold uppercase ${
                  side === s
                    ? s === "long"
                      ? "border-mint-500/60 bg-mint-500/10 text-mint-400"
                      : "border-flame-500/60 bg-flame-500/10 text-flame-400"
                    : "border-ink-600 text-slate-500"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="text-[11px] text-slate-400">
          Margin (USDC)
          <input
            value={margin}
            onChange={(e) => {
              setMargin(e.target.value);
              setMarginTouched(true);
              reset();
            }}
            inputMode="decimal"
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          />
          {suggested !== null && !marginTouched && (
            <span className="text-[10px] text-slate-600">suggested {fmtUsd(suggested)} (1% of equity)</span>
          )}
        </label>
        <label className="text-[11px] text-slate-400">
          Leverage
          <input
            value={leverage}
            onChange={(e) => {
              setLeverage(e.target.value);
              reset();
            }}
            inputMode="decimal"
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          />
        </label>
        <div className="flex items-end">
          <button
            onClick={() => void prepare()}
            disabled={busy}
            className="w-full rounded border border-sky-400/50 px-2 py-1.5 text-xs font-bold text-sky-400 hover:bg-sky-400/10 disabled:opacity-50"
          >
            {busy ? "…" : "1 · Prepare"}
          </button>
        </div>
      </div>

      {deskMark !== undefined && deskMark > 0 && (
        <div className="mt-2 text-[11px] text-slate-500">
          Desk mark {fmtUsd(deskMark)} · server re-prices independently at prepare time.
        </div>
      )}

      {wallet.kind === "metamask" && wallet.address && (
        <div className="mt-3 rounded border border-ink-700 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">
              On-chain positions {positions !== null ? `(${positions.length})` : ""}
            </span>
            <button
              onClick={() => void refreshPositions()}
              className="ml-auto text-[10px] text-slate-500 underline hover:text-slate-300"
            >
              refresh
            </button>
          </div>
          {positions === null ? (
            <div className="mt-1 text-[11px] text-slate-600">Loading…</div>
          ) : positions.length === 0 ? (
            <div className="mt-1 text-[11px] text-slate-600">No open GMX positions for this account.</div>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              {positions.map((p) => (
                <div
                  key={p.positionKey}
                  className="flex flex-wrap items-center gap-2 rounded bg-ink-850 px-2.5 py-1.5 text-[11px]"
                >
                  <span className={`font-bold ${p.isLong ? "text-mint-400" : "text-flame-400"}`}>
                    {p.side.toUpperCase()}
                  </span>
                  <span className="font-semibold text-slate-200">{p.symbol ?? `${p.market.slice(0, 10)}…`}</span>
                  <span className="text-slate-400">
                    {p.sizeUsd !== null ? fmtUsd(p.sizeUsd) : "?"} · coll{" "}
                    {p.collateralUsd !== null ? fmtUsd(p.collateralUsd) : "?"}
                  </span>
                  {p.unrealizedPnlUsd !== null && (
                    <span className={p.unrealizedPnlUsd >= 0 ? "text-mint-400" : "text-flame-400"}>
                      {fmtUsd(p.unrealizedPnlUsd, { sign: true })}
                    </span>
                  )}
                  {p.symbol && p.sizeUsd !== null && p.collateralUsd !== null ? (
                    <button
                      onClick={() => void closePosition(p)}
                      disabled={busy}
                      className="ml-auto rounded border border-flame-500/50 px-2 py-0.5 text-[10px] font-bold text-flame-400 hover:bg-flame-500/10 disabled:opacity-50"
                    >
                      Close
                    </button>
                  ) : (
                    <span className="ml-auto text-[10px] text-slate-600">close in GMX app</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-1 text-[10px] text-slate-600">Indexer lags chain by seconds.</div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded border border-flame-500/30 bg-flame-500/5 px-3 py-2 text-xs text-flame-400">
          {error}
        </div>
      )}

      {prepared && (
        <div className="mt-3 rounded border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-xs">
          <div className="font-bold tracking-widest text-gold-400">
            REVIEW — {prepared.decode.orderType} · {preparedLabel}
          </div>
          <div className="mt-1 grid gap-1 text-slate-300 md:grid-cols-2">
            <span>
              {prepared.decode.orderType === "MarketDecrease" ? "Close size" : "Notional"}{" "}
              {fmtUsd(prepared.quote.notionalUsd)}
            </span>
            <span>Acceptable price {fmtUsd(prepared.quote.acceptablePriceUsd)}</span>
            <span>Execution fee ≈ {prepared.quote.executionFeeEth} ETH (excess refunded)</span>
            <span className="break-all">Sends to {prepared.tx.to}</span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {prepared.decode.orderType === "MarketDecrease" ? (
              <>No approval needed — collateral is already locked. Closing is keeper-executed; track the tx hash.</>
            ) : (
              <>
                First approve the GMX Router to pull {fmtUsd(Number(margin) || 0)} USDC, then send. Creation is not a
                fill — keepers execute afterwards; track the tx hash.
              </>
            )}
          </div>
          {isTestnet && (
            <div className="mt-1 text-[11px] text-mint-400">Testnet chain — use test funds only.</div>
          )}
          <button
            onClick={() => void send()}
            disabled={busy || txHash !== null}
            className="mt-2 rounded border border-flame-500/60 px-3 py-1.5 text-xs font-bold text-flame-400 hover:bg-flame-500/10 disabled:opacity-50"
          >
            {busy ? "…" : txHash ? "Sent — see below" : "2 · Send via MetaMask"}
          </button>
        </div>
      )}

      {txHash && (
        <div className="mt-3 rounded border border-ink-600 px-3 py-2 text-xs">
          <div className="break-all text-slate-300">
            tx <span className="font-mono">{txHash}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={() => void track()}
              disabled={busy}
              className="rounded border border-ink-600 px-2 py-1 text-[11px] font-bold text-slate-300 hover:border-mint-500/60 hover:text-mint-400 disabled:opacity-50"
            >
              {busy ? "…" : "3 · Check creation status"}
            </button>
            {tracked && (
              <span
                className={`text-[11px] font-bold ${
                  tracked.status === "success"
                    ? "text-mint-400"
                    : tracked.status === "reverted"
                      ? "text-flame-400"
                      : "text-gold-400"
                }`}
              >
                {tracked.status === "success"
                  ? "Created on-chain — awaiting keeper execution (check GMX app for the fill)"
                  : tracked.status === "reverted"
                    ? "Reverted — no order created, gas spent"
                    : "Pending — not mined yet"}
                {tracked.blockNumber !== null ? ` · block ${tracked.blockNumber}` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
