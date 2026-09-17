import type { MarketPair } from "./types";

/**
 * CoinGecko coin id -> pair id in our MarketPair list.
 * Pair ids come from lib/market.ts (`sol-<base>` / `evm-<base>`).
 *
 * Cross-quoted pairs (JUP/SOL, BONK/SOL, WBTC/ETH) are derived from the
 * USD legs: JUP/SOL = jupUSD / solUSD — same as the real synthetic pair.
 */
export const COIN_TO_PAIR: Record<string, string> = {
  solana: "sol-sol",
  "jupiter-exchange-solana": "sol-jup",
  bonk: "sol-bonk",
  dogwifcoin: "sol-wif",
  "jito-governance-token": "sol-jto",
  ethereum: "evm-eth",
  "wrapped-bitcoin": "evm-wbtc",
  arbitrum: "evm-arb",
  optimism: "evm-op",
  chainlink: "evm-link",
  uniswap: "evm-uni",
  aave: "evm-aave",
};

export interface PriceFeed {
  source: "coingecko" | "binance";
  at: number;
  prices: Record<string, number>; // coinId -> USD price
  changes24h?: Record<string, number>; // coinId -> 24h change percent (when upstream provides it)
  volumes24h?: Record<string, number>; // coinId -> 24h quote volume in USD (Binance path)
}

/**
 * Blend a live feed into the market state. Mutates nothing: returns new pair objects.
 *
 * - price is overwritten with the live value (prevPrice rolled for tick-flash colors)
 * - spark gets the live point appended (48-point window kept)
 * - change24h adopted from the feed when provided (cross pairs derive it from legs)
 * - volume24h adopted when provided, otherwise gently re-anchored to the move
 * - volatility gets a refresh from the tick-to-tick return (slow EMA)
 * - pairs the feed doesn't cover hold their last values (staleness is visible
 *   via liveLastAt — there is no simulated walk anymore)
 */
export function applyLivePrices(pairs: MarketPair[], feed: PriceFeed, now: number): MarketPair[] {
  const usd = feed.prices;
  const live = new Map<string, { price: number; change24h?: number; volume?: number }>();

  for (const [coinId, pairId] of Object.entries(COIN_TO_PAIR)) {
    const price = usd[coinId];
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      const change = feed.changes24h?.[coinId];
      const volume = feed.volumes24h?.[coinId];
      live.set(pairId, {
        price,
        change24h: typeof change === "number" && Number.isFinite(change) ? change : undefined,
        volume: typeof volume === "number" && Number.isFinite(volume) && volume > 0 ? volume : undefined,
      });
    }
  }

  // Cross-rate pairs from the USD legs. A directly supplied change24h wins;
  // otherwise derive it from the legs: (1+cb)/(1+cq)-1.
  const put = (pairId: string, price: number, change24h?: number) => {
    const existing = live.get(pairId);
    live.set(pairId, {
      price,
      change24h: existing?.change24h ?? change24h,
      volume: existing?.volume,
    });
  };
  const cross = (baseCoin: string, quoteCoin: string): { price: number; change24h?: number } | undefined => {
    const b = usd[baseCoin];
    const q = usd[quoteCoin];
    if (typeof b !== "number" || typeof q !== "number" || q <= 0) return undefined;
    const cb = feed.changes24h?.[baseCoin];
    const cq = feed.changes24h?.[quoteCoin];
    const change24h =
      typeof cb === "number" && typeof cq === "number" && Number.isFinite(cb) && Number.isFinite(cq)
        ? ((1 + cb / 100) / (1 + cq / 100) - 1) * 100
        : undefined;
    return { price: b / q, change24h };
  };
  const jupSol = cross("jupiter-exchange-solana", "solana");
  if (jupSol !== undefined) put("sol-jup", jupSol.price, jupSol.change24h);
  const bonkSol = cross("bonk", "solana");
  if (bonkSol !== undefined) put("sol-bonk", bonkSol.price, bonkSol.change24h);
  const wbtcEth = cross("wrapped-bitcoin", "ethereum");
  if (wbtcEth !== undefined) put("evm-wbtc", wbtcEth.price, wbtcEth.change24h);

  return pairs.map((p) => {
    const hit = live.get(p.id);
    if (!hit) return p; // uncovered pair holds last values; liveLastAt reveals staleness

    const wasLive = p.liveLastAt !== null;
    const prev = p.price;
    const tickRet = Math.abs(hit.price / prev - 1);

    const spark = p.spark.length >= 48 ? p.spark.slice(1) : p.spark.slice();
    spark.push(hit.price);

    const scale = hit.price / prev;
    // Adopt the feed's 24h change when it provides one. Otherwise evolve the
    // pair's change24h by THIS poll's move only, decayed toward the last
    // authoritative value — never a running sum of blend deltas (that drifts
    // cross-quoted pairs to nonsense like -104%).
    const fallback =
      (wasLive ? p.change24h * 0.6 : p.change24h) + (wasLive ? (scale - 1) * 100 : 0);
    const change24h =
      typeof hit.change24h === "number" && Number.isFinite(hit.change24h)
        ? hit.change24h
        : fallback;

    return {
      ...p,
      // First live anchor must not leak the sim->live jump into prevPrice
      // (that would fake a tick flash); afterwards roll it for tick colors.
      prevPrice: wasLive ? prev : hit.price,
      price: hit.price,
      liveLastAt: now,
      change24h,
      volume24h: hit.volume ?? p.volume24h * (0.9 + 0.1 * scale), // adopt feed volume; else gentle re-anchor
      liquidity: p.liquidity * (0.95 + 0.05 * scale),
      volatility: clamp01(p.volatility * 0.9 + clamp01(tickRet * 40) * 0.1),
      spark,
    };
  });
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}
