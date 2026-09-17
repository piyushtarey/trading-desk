# Setup & Development

## Prerequisites

- Node.js 20+ (Next 15 requires ≥ 18.18; 20 LTS recommended)
- npm (lockfile `package-lock.json` is committed)
- No database, no env keys, no browser wallet required (Demo wallet works without extensions)

## Install

```powershell
npm install
```

Installs Next 15.4.6, React 19.1.1, Tailwind 4, TypeScript, `@solana/web3.js`.

## Run

```powershell
npm run dev      # http://localhost:3000
```

Custom port (e.g. preview on 3512):

```powershell
npm run dev -- -p 3512
```

Detached on Windows PowerShell (stdout/stderr to separate files):

```powershell
powershell -NoProfile -Command "(Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev','--','-p','3512' -RedirectStandardOutput '.freebuff\preview-xxx.log' -RedirectStandardError '.freebuff\preview-xxx.log.err' -WindowStyle Hidden -PassThru).Id"
```

## Checks

```powershell
npm run typecheck  # tsc --noEmit
npm run build      # production build — stop the dev server first (clobbers .next)
npm run start      # serve the production build (default port 3000)
```

## Live data behavior

- No `.env*` needed. Price/wallet paths use public endpoints only.
- `GET /api/prices` tries CoinGecko first (free tier rate-limits aggressively), falls back to Binance, else the client keeps simulating. A `502` from the API is normal under rate limits — the ticker badge flips to `SIM`/`STALE` and the desk continues.
- `POST /api/sol-balance` proxies `https://api.mainnet-beta.solana.com` because browsers get 403 calling it directly. Failures leave the balance blank; Demo wallet always works.
- First paint is seeded with 48h of deterministic history (`lib/seed.ts`, mulberry32 seed `1337`), so the desk looks alive before the first live poll.

## Git-ignored (local only)

```
node_modules  .next  out  *.tsbuildinfo  .DS_Store  dev.log  .freebuff/
```

`.freebuff/` holds local preview logs and scratch (`preview-*.log`, `cheatbook.*`, `run.md`) — never committed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Ticker shows `SIM` | Both upstream price sources failed or 30s cache + 15s poll haven't landed yet; check `/api/prices` directly, wait, retry |
| `502 No upstream price source` | CoinGecko rate-limited **and** Binance unreachable; desk continues on sim — no action required |
| Phantom/MetaMask "not detected" | Extension not installed or page needs reload; detection rescans (`400ms` + every 6s) and supports EIP-6963; use **Demo wallet** to bypass |
| MetaMask signing fails | Must approve `eth_signTypedData_v4` on Arbitrum One; the desk attempts `wallet_switchEthereumChain (0xa4b1)` / `wallet_addEthereumChain` automatically; Demo wallet signs instantly with a fake `0x…` |
| `npm run build` fails while dev runs | Stop dev server first; both write `.next` |
| Hydration warnings | Desk state is client-only by design (`BootScreen` until mount); don't move `createInitialState` into render |
| Port busy | Pass `-- -p <free-port>`; 3000-class ports are often occupied by previews |
