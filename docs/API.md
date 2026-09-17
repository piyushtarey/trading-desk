# API Reference

## `GET /api/prices` (`app/api/prices/route.ts`)

Live crypto price feed for the desk. `export const dynamic = "force-dynamic"`.

### Strategy

1. Serve in-memory cache if fresh (`CACHE_TTL_MS = 30s`).
2. Try **CoinGecko** `simple/price` (one call, includes 24h change).
3. On failure, try **Binance** `ticker/price` (multi-symbol, USDT legs + crosses).
4. Both fail → `502` (client keeps simulating).

All fetches: `cache: "no-store"`, `Accept: application/json`, 6s abort timeout.

### Upstream details

- **CoinGecko** (`fromCoinGecko`, `app/api/prices/route.ts:68`): `ids = solana, jupiter-exchange-solana, bonk, dogwifcoin, jito-governance-token, ethereum, wrapped-bitcoin, arbitrum, optimism, chainlink, uniswap, aave`; `vs_currencies=usd&include_24hr_change=true`. Throws if `< 6` prices.
- **Binance** (`fromBinance`, `app/api/prices/route.ts:83`): `symbols = SOLUSDT, ETHUSDT, BTCUSDT, ARBUSDT, OPUSDT, LINKUSDT, UNIUSDT, AAVEUSDT, WIFUSDT, JUPUSDT, BONKUSDT`. Direct maps for 10 coins; cross `jupiter-exchange-solana = JUPUSDT / SOLUSDT`. Throws if `< 6` prices. No 24h changes from this path.

### Success response (200)

```json
{
  "source": "coingecko | binance",
  "at": 1726500000000,
  "prices": { "solana": 148.32, "ethereum": 3120.5 },
  "changes24h": { "solana": 2.14 },
  "cached": false
}
```

- `changes24h` present only on the CoinGecko path.
- `cached: true` when served from the 30s server cache.

### Error response (502)

```json
{ "error": "No upstream price source available (<reason>)" }
```

### Client blending (`lib/prices.ts`, `lib/store.tsx`)

- Client polls every 15s (`POLL_MS`) with `{cache:"no-store"}`; failures swallowed.
- `COIN_TO_PAIR` maps the 12 CoinGecko IDs → desk pair IDs; crosses recomputed client-side too (`JUP/SOL`, `BONK/SOL` ÷ SOLUSD; `WBTC/ETH` ÷ ETHUSD).
- Per hit: `prevPrice/price`, spark push (cap 48), `change24h` (feed value or damped sim + tick return), volume/liquidity scaling, volatility EMA (`vol*0.9 + clamp01(|tickRet|*40)*0.1`), `liveLastAt = now`, `marketSource = source`.
- Ticker badge (`components/Ticker.tsx`): `LIVE·BINANCE / LIVE·COINGECKO` if `age < 45s`, `STALE` if `< 120s`, else `SIM`.

### Example

```powershell
curl http://localhost:3000/api/prices
```

## `POST /api/sol-balance` (`app/api/sol-balance/route.ts`)

Solana balance proxy — browsers calling `https://api.mainnet-beta.solana.com` directly get 403, so the server proxies `getBalance`.

### Request

```json
{ "address": "<base58, 32–44 chars>" }
```

- `Content-Type: application/json`. Invalid JSON → `400`.
- Address validated against `^[1-9A-HJ-NP-Za-km-z]{32,44}$` → `400 { error: "invalid Solana address" }` otherwise.

### Success response (200)

```json
{ "lamports": 1234567890 }
```

`lamports / 1e9 = SOL`.

### Error responses

| Status | Body | Cause |
|---|---|---|
| 400 | `{ error: "invalid JSON body" }` | Unparseable body |
| 400 | `{ error: "invalid Solana address" }` | Fails base58 check |
| 502 | `{ error: "balance lookup failed (<reason>)" }` | RPC unreachable / 6s timeout / bad payload |

### RPC details

`POST https://api.mainnet-beta.solana.com` with `{ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }`, 6s abort timeout; returns `result.value` (lamports).

### Client usage (`lib/wallet.tsx`)

`refreshPhantomBalance` tries (1) provider `request({method:"getBalance"})`, (2) this proxy, (3) provider `getBalance()` — first success wins; all fail → balance `null` (UI shows address without balance).

### Example

```powershell
curl -X POST http://localhost:3000/api/sol-balance `
  -H "Content-Type: application/json" `
  -d '{"address":"So11111111111111111111111111111111111111112"}'
```
