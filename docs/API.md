# API Reference

## `GET /api/prices` (`app/api/prices/route.ts`)

Live crypto price feed for the desk. `export const dynamic = "force-dynamic"`.

### Strategy

1. Serve in-memory cache if fresh (`CACHE_TTL_MS = 30s`).
2. Try **CoinGecko** `simple/price` (one call, includes 24h change).
3. On failure, try **Binance** `ticker/price` (multi-symbol, USDT legs + crosses).
4. Both fail → `502` (client holds last live prices and marks them STALE; the scout idles).

All fetches: `cache: "no-store"`, `Accept: application/json`, 6s abort timeout.

### Upstream details

- **CoinGecko** (`fromCoinGecko`, `app/api/prices/route.ts:68`): `ids = solana, jupiter-exchange-solana, bonk, dogwifcoin, jito-governance-token, ethereum, wrapped-bitcoin, arbitrum, optimism, chainlink, uniswap, aave`; `vs_currencies=usd&include_24hr_change=true`. Throws if `< 6` prices.
- **Binance** (`fromBinance`): `ticker/24hr` for `SOLUSDT, ETHUSDT, BTCUSDT, ARBUSDT, OPUSDT, LINKUSDT, UNIUSDT, AAVEUSDT, WIFUSDT, JUPUSDT, BONKUSDT` — last price, 24h change %, and quote volume per symbol. Direct maps for 10 coins; cross `jupiter-exchange-solana = JUPUSDT / SOLUSDT` with change derived from the legs. Throws if `< 6` prices. Both CoinGecko and Binance now supply 24h changes.

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

- `changes24h` present on both CoinGecko and Binance paths; `volumes24h` (24h quote volume USD) on the Binance path only.
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

## `GET /api/orders/markets`

Venue allowlist (M3, GMX v2). `403` unless `DESK_LIVE_ORDERS_ENABLED=true`;
`503` when venue config is missing/invalid (reason included, fail closed).

```json
{
  "venue": "gmx-v2",
  "chainId": 42161,
  "slippageBps": 50,
  "executionFeeWei": "800000000000000",
  "markets": [
    { "symbol": "ETH/USDC", "market": "0x70d9…", "indexToken": "0x82aF…", "indexDecimals": 18, "longToken": "0x82aF…", "shortToken": "0xaf88…", "collateralToken": "0xaf88…", "collateralDecimals": 6 }
  ]
}
```

## `POST /api/orders/prepare`

Build the UNSIGNED GMX multicall for the wallet to send. Body:
`{ kind?: "increase"|"decrease", intent?, decrease?, account: "0x…", markPrice?, context? }`.

- increase (default): `{ intent: {symbol, side, sizeUsd, leverage, ...} }` →
  M1 gates (validate → 400, halt → 423, caps → 422) → MarketIncrease.
- decrease: `{ decrease: {symbol, side, sizeDeltaUsd, collateralDeltaUsd} }` →
  validate → halt → MarketDecrease. Caps bypassed (exits); on-chain size
  cross-check when readable (422 on oversize), warning when not.

Shared: venue config (503) → market allowlist (422 + `listed`) → independent
server mark (502 when no feed; 422 when a client `markPrice` diverges >2%) →
bytecode check (503) → quote + build.

Success (200) returns `{ ok, venue: "gmx-v2", chainId, serverMark, tx: {to, data, value},
approvals, quote, decode, warnings }`. `tx.value` is wei as a decimal string —
convert to hex before `eth_sendTransaction`.

## `POST /api/orders/track`

Body: `{ txHash: "0x…" }` → `{ status: "pending"|"success"|"reverted", blockNumber, txHash }`.
`pending` covers mempool and unknown hashes. `success` = creation landed, NOT a fill
(GMX keepers execute afterwards). `502` on RPC failure; `503` when unconfigured.

## `GET /api/positions?account=0x…`

Open GMX positions via the Subsquid indexer (Arbitrum One only):
`{ venue, chainId, account, positions: [{positionKey, market, symbol|null, side,
sizeUsd, collateralUsd, entryPriceUsd, leverage, unrealizedPnlUsd, openedAt, raw}],
indexedNote }`. `403` unless live orders enabled; `400` on bad address;
`502` on indexer failure. Display truth only — exits never depend on it.

## `GET /api/llm/status`

`{ mode, configured, provider?, model?, promptVersions? }` (no secrets).
`configured: false` + reason when key/provider/mode is missing or invalid.

## `POST /api/llm/scout`

Body: `{ pairs: [{symbol, chain, change24h, volatility 0..1, liquidity, liveAgeMs}] }`
(max 20). Always returns deterministic heat top-5; in shadow/advisory also calls
the model (`scout-v1`), validates strictly, and returns `{ candidates, agreement:
{detTop, overlap, of}, latencyMs }` — or `llm: null` when validation drops it.
Modes off/proposing → `403`; unconfigured → `503`.

## `POST /api/llm/analyst`

Body: `{ input: {symbol, momentum, liquidity, volatility, trend} }` (0..100, clamped).
Returns deterministic `{ final, signal }` plus optional validated model
`{ score, signal, reason }` with `{ signalMatch, scoreDelta }`. Same mode policy
as scout. Model text is sanitized, display-only, never executable.
