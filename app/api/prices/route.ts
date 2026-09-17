/**
 * Live crypto prices API (server-side).
 *
 * Primary:  CoinGecko simple/price — one call covers the whole universe,
 *           includes 24h change. Free tier rate-limits aggressively, hence:
 * Fallback: Binance /api/v3/ticker/price (multi-symbol ping). Non-USDT pairs
 *           are cross rates of the USD legs (JUP/SOL = JUPUSDT ÷ SOLUSDT).
 *
 * The result is cached in-memory for 30s so all clients share one upstream call.
 * Response: { source, at, prices: Record<coinId, number>, changes24h?, cached? }
 * Both sources failing -> 502 JSON (client keeps simulating prices).
 */

export const dynamic = "force-dynamic";

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

interface PriceFeed {
  source: "coingecko" | "binance";
  at: number;
  prices: Record<string, number>;
  changes24h?: Record<string, number>;
}

let cache: PriceFeed | null = null;

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

async function fromCoinGecko(): Promise<PriceFeed> {
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

async function fromBinance(): Promise<PriceFeed> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(
    JSON.stringify([...BINANCE_SYMBOLS])
  )}`;
  const raw = (await fetchJson(url)) as { symbol: string; price: string }[];
  const usdt: Record<string, number> = {};
  for (const row of Array.isArray(raw) ? raw : []) {
    const p = Number(row.price);
    if (Number.isFinite(p)) usdt[row.symbol] = p;
  }

  const prices: Record<string, number> = {};
  const set = (coinId: string, sym: string) => {
    const v = usdt[sym];
    if (typeof v === "number") prices[coinId] = v;
  };
  const cross = (coinId: string, baseSym: string, quoteSym: string) => {
    const b = usdt[baseSym];
    const q = usdt[quoteSym];
    if (typeof b === "number" && typeof q === "number" && q > 0) prices[coinId] = b / q;
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
  // Cross-quoted synthetic pairs from the USD legs.
  cross("jupiter-exchange-solana", "JUPUSDT", "SOLUSDT");

  if (Object.keys(prices).length < 6) throw new Error("binance payload incomplete");
  return { source: "binance", at: Date.now(), prices };
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return Response.json({ ...cache, cached: true });
    }
    let feed: PriceFeed;
    try {
      feed = await fromCoinGecko();
    } catch {
      feed = await fromBinance(); // throws -> 502 path below
    }
    cache = feed;
    return Response.json({ ...feed, cached: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return Response.json({ error: `No upstream price source available (${msg})` }, { status: 502 });
  }
}
