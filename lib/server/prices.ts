/**
 * Server-only upstream price fetching (CoinGecko -> Binance ticker/24hr,
 * 30s in-memory cache). Used by GET /api/prices and by order prepare for an
 * independent server-side mark. Never import from client code.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/server/prices imported from client code");
}

const COINGECKO_IDS = [
  "solana", // SOL
  "jupiter-exchange-solana", // JUP
  "bonk", // BONK
  "dogwifcoin", // WIF
  "jito-governance-token", // JTO
  "ethereum", // ETH
  "wrapped-bitcoin", // WBTC
  "arbitrum", // ARB
  "optimism", // OP
  "chainlink", // LINK
  "uniswap", // UNI
  "aave", // AAVE
] as const;

const BINANCE_SYMBOLS = [
  "SOLUSDT",
  "ETHUSDT",
  "BTCUSDT",
  "ARBUSDT",
  "OPUSDT",
  "LINKUSDT",
  "UNIUSDT",
  "AAVEUSDT",
  "WIFUSDT",
  "JUPUSDT",
  "BONKUSDT",
] as const;

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 6_000;

export interface ServerPriceFeed {
  source: "coingecko" | "binance";
  at: number;
  prices: Record<string, number>;
  changes24h?: Record<string, number>;
  volumes24h?: Record<string, number>;
}

let cache: ServerPriceFeed | null = null;

function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as unknown;
    })
    .finally(() => clearTimeout(timer));
}

async function fromCoinGecko(): Promise<ServerPriceFeed> {
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS.join(",")}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const raw = (await fetchJson(url)) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const prices: Record<string, number> = {};
  const changes24h: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v?.usd === "number") prices[id] = v.usd;
    if (typeof v?.usd_24h_change === "number") changes24h[id] = v.usd_24h_change;
  }
  if (Object.keys(prices).length < 6) throw new Error("coingecko payload incomplete");
  return { source: "coingecko", at: Date.now(), prices, changes24h };
}

async function fromBinance(): Promise<ServerPriceFeed> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(
    JSON.stringify([...BINANCE_SYMBOLS])
  )}`;
  const raw = (await fetchJson(url)) as {
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    quoteVolume: string;
  }[];
  const legs = new Map<string, { price: number; change: number; volume: number }>();
  for (const row of Array.isArray(raw) ? raw : []) {
    const price = Number(row.lastPrice);
    const change = Number(row.priceChangePercent);
    const volume = Number(row.quoteVolume);
    if (Number.isFinite(price) && price > 0) {
      legs.set(row.symbol, {
        price,
        change: Number.isFinite(change) ? change : 0,
        volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
      });
    }
  }

  const prices: Record<string, number> = {};
  const changes24h: Record<string, number> = {};
  const volumes24h: Record<string, number> = {};
  const set = (coinId: string, sym: string) => {
    const leg = legs.get(sym);
    if (!leg) return;
    prices[coinId] = leg.price;
    changes24h[coinId] = leg.change;
    if (leg.volume > 0) volumes24h[coinId] = leg.volume;
  };
  const cross = (coinId: string, baseSym: string, quoteSym: string) => {
    const b = legs.get(baseSym);
    const q = legs.get(quoteSym);
    if (!b || !q || q.price <= 0) return;
    prices[coinId] = b.price / q.price;
    changes24h[coinId] = ((1 + b.change / 100) / (1 + q.change / 100) - 1) * 100;
  };

  set("solana", "SOLUSDT");
  set("ethereum", "ETHUSDT");
  set("wrapped-bitcoin", "BTCUSDT");
  set("arbitrum", "ARBUSDT");
  set("optimism", "OPUSDT");
  set("chainlink", "LINKUSDT");
  set("uniswap", "UNIUSDT");
  set("aave", "AAVEUSDT");
  set("dogwifcoin", "WIFUSDT");
  set("bonk", "BONKUSDT");
  cross("jupiter-exchange-solana", "JUPUSDT", "SOLUSDT");

  if (Object.keys(prices).length < 6) throw new Error("binance payload incomplete");
  return { source: "binance", at: Date.now(), prices, changes24h, volumes24h };
}

/**
 * Shared upstream fetch. Throws when both sources fail — callers answer 502.
 */
export async function getPriceFeed(): Promise<ServerPriceFeed & { cached: boolean }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache, cached: true };
  }
  let feed: ServerPriceFeed;
  try {
    feed = await fromCoinGecko();
  } catch {
    feed = await fromBinance();
  }
  cache = feed;
  return { ...feed, cached: false };
}
