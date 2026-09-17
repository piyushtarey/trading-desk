"use client";

import { useDesk } from "@/lib/store";
import { fmtPct } from "@/lib/format";

const FRESH_MS = 45_000; // LIVE
const STALE_MS = 120_000; // STALE; after that -> SIM

export default function Ticker() {
  const { state } = useDesk();

  const items = state.pairs.map((p) => {
    const up = p.price >= p.prevPrice;
    return (
      <span
        key={p.id}
        className={`mx-4 inline-flex items-baseline gap-2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${
          up ? "anim-flash-green" : "anim-flash-red"
        }`}
      >
        <span className="font-semibold text-slate-200">{p.symbol}</span>
        <span className={up ? "text-mint-400" : "text-flame-400"}>
          {up ? "▲" : "▼"} {formatPrice(p.price)}
        </span>
        <span className={p.change24h >= 0 ? "text-mint-400/70" : "text-flame-400/70"}>{fmtPct(p.change24h)}</span>
      </span>
    );
  });

  return (
    <div className="relative flex h-6 items-center overflow-hidden">
      <FeedBadge source={state.marketSource} lastLiveAt={state.lastLiveAt} now={state.now} />
      <div className="anim-ticker flex w-max items-center">
        {items}
        {items}
      </div>
    </div>
  );
}

function FeedBadge({ source, lastLiveAt, now }: { source: string; lastLiveAt: number | null; now: number }) {
  const age = lastLiveAt === null ? Infinity : now - lastLiveAt;
  const live = age < FRESH_MS;
  const stale = !live && age < STALE_MS;

  const dot = live ? "bg-mint-400" : stale ? "bg-gold-400" : "bg-slate-500";
  const text = live ? "text-mint-400" : stale ? "text-gold-400" : "text-slate-500";
  const label = live ? (source === "binance" ? "LIVE · BINANCE" : "LIVE · COINGECKO") : stale ? "STALE" : "SIM";
  const pulse = live ? "animate-pulse" : "";

  return (
    <span
      title={
        live
          ? `Prices from ${source} API, refreshed continuously`
          : stale
            ? "Live feed unreachable — showing last known prices"
            : "Simulated prices (live feed unreachable)"
      }
      className={`z-10 mr-3 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-ink-600 bg-ink-850 px-2 py-0.5 text-[9px] font-bold tracking-wider ${text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse}`} />
      {label}
    </span>
  );
}

function formatPrice(n: number) {
  if (n >= 1000) return n.toFixed(1);
  if (n >= 1) return n.toFixed(3);
  return n.toPrecision(4);
}
