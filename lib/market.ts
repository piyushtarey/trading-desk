import { clamp } from "./rng";
import type { MarketPair } from "./types";

export interface PairSeed {
  base: string;
  quote: string;
  chain: "solana" | "evm";
  price: number;
  vol: number; // volatility 0..1
  liq: number; // liquidity in USD
}

export const PAIR_SEEDS: PairSeed[] = [
  { base: "SOL", quote: "USDC", chain: "solana", price: 148.32, vol: 0.55, liq: 42_000_000 },
  { base: "JUP", quote: "SOL", chain: "solana", price: 0.86, vol: 0.7, liq: 8_400_000 },
  { base: "BONK", quote: "SOL", chain: "solana", price: 0.0000216, vol: 0.85, liq: 3_100_000 },
  { base: "WIF", quote: "USDC", chain: "solana", price: 1.94, vol: 0.8, liq: 6_200_000 },
  { base: "JTO", quote: "USDC", chain: "solana", price: 2.61, vol: 0.75, liq: 4_800_000 },
  { base: "ETH", quote: "USDC", chain: "evm", price: 3120.5, vol: 0.45, liq: 120_000_000 },
  { base: "WBTC", quote: "ETH", chain: "evm", price: 19.8, vol: 0.4, liq: 60_000_000 },
  { base: "ARB", quote: "USDC", chain: "evm", price: 0.74, vol: 0.72, liq: 18_000_000 },
  { base: "OP", quote: "USDC", chain: "evm", price: 1.62, vol: 0.7, liq: 15_500_000 },
  { base: "LINK", quote: "USDC", chain: "evm", price: 14.27, vol: 0.6, liq: 28_000_000 },
  { base: "UNI", quote: "USDC", chain: "evm", price: 7.83, vol: 0.65, liq: 12_600_000 },
  { base: "AAVE", quote: "USDC", chain: "evm", price: 142.6, vol: 0.6, liq: 20_000_000 },
];

export function createMarket(now: number): MarketPair[] {
  return PAIR_SEEDS.map((seed, i) => {
    const spark: number[] = [];
    let p = seed.price;
    for (let k = 0; k < 24; k++) {
      spark.push(p);
      p *= 1 + (Math.sin(i * 3.7 + k * 0.9) * 0.5 + (Math.random() - 0.5)) * 0.004;
    }
    return {
      id: seed.chain === "solana" ? `sol-${seed.base.toLowerCase()}` : `evm-${seed.base.toLowerCase()}`,
      symbol: `${seed.base}/${seed.quote}`,
      base: seed.base,
      quote: seed.quote,
      chain: seed.chain,
      price: seed.price,
      prevPrice: seed.price,
      change24h: (Math.random() - 0.45) * 8,
      volume24h: seed.liq * (0.4 + Math.random() * 0.8),
      liquidity: seed.liq,
      volatility: seed.vol,
      spark,
      liveLastAt: null,
    };
  });
}

// Advance all pairs one tick with correlated random walk.
export function tickMarket(pairs: MarketPair[]): MarketPair[] {
  const marketShove = (Math.random() - 0.5) * 0.002; // global drift
  return pairs.map((p) => {
    const vol = 0.0012 + p.volatility * 0.004;
    const shock = Math.random() < 0.03 ? (Math.random() - 0.5) * 0.02 : 0;
    const next = Math.max(1e-9, p.price * (1 + marketShove + (Math.random() - 0.5) * vol * 2 + shock));
    const spark = p.spark.length >= 48 ? p.spark.slice(1) : p.spark.slice();
    spark.push(next);
    return {
      ...p,
      prevPrice: p.price,
      price: next,
      change24h: p.change24h * 0.999 + (next / p.prevPrice - 1) * 100 * 0.05,
      volume24h: p.volume24h * (0.999 + Math.random() * 0.002),
      spark,
    };
  });
}

export function pairVolatility(p: MarketPair) {
  return clamp(p.volatility, 0, 1);
}

export function findPair(pairs: MarketPair[], pairId: string) {
  return pairs.find((p) => p.id === pairId);
}
