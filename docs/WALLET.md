# Wallets

`lib/wallet.tsx` (`"use client"`). Display + balance for spot; **signing only for perp tickets**. No real orders.

## Kinds

| Kind | Chain | Currency | Network | Explorer |
|---|---|---|---|---|
| `phantom` 👻 | Solana Mainnet | SOL (÷1e9 lamports) | `solana:mainnet` | solscan.io |
| `metamask` 🦊 | EVM (execution: Arbitrum One `0xa4b1`) | ETH (÷1e18 wei) | detected chainId → name | etherscan.io |
| `demo` ⚡ | Paper | USD $24,817.42 (`DEMO_USD`) | `paper` | — (address `DemoXXXX…xz`) |

`WalletState`: `{ connected, kind, address, short, balance, balanceSymbol, network, connecting, error, demoFallback, demoBalanceUsd, detected {phantom, metamask} }`.

## Detection

- **EIP-6963**: on module load, listens for `eip6963:announceProvider`, stores `rdns → provider`; `requestEip6963()` re-dispatches on demand. `waitForProvider` polls + re-requests for ~2.5s.
- **Phantom** (`getPhantom`): `window.phantom.solana` else `window.solana` if `isPhantom`.
- **MetaMask** (`getMetaMask`): 6963 `io.metamask` first, else candidates from `window.providers + window.ethereum + ethereum.providers`, filtering `isMetaMask && !isPhantom`, preferring `_metamask` (spoof-resistant).
- UI rescans immediately, after 400ms, and every 6s (`detected` drives "not detected" hints).

## Connect / disconnect

- `connect("demo")`: instant — random `DemoXXXX…xz` address, paper USD, persisted.
- `connect("phantom")`: `waitForProvider(getPhantom)` → missing → `demoFallback=true` + error; else `provider.connect()` → base58 address → persist → `refreshPhantomBalance`.
- `connect("metamask")`: same pattern; `eth_requestAccounts` → address → persist → `refreshMetaMaskBalance` (chain + balance).
- `disconnect()`: Phantom `disconnect()` best-effort, reset to `INITIAL`, clear persisted kind.
- Persistence: `localStorage` key `tradingdesk.wallet.v2` stores `kind` only. On mount: demo restores instantly; Phantom reconnects `onlyIfTrusted`; MetaMask reconnects via `eth_accounts` (non-empty = previously connected).
- Provider events: `accountsChanged` (empty → disconnect; else switch + refresh), `chainChanged` (re-refresh MetaMask), Solana `accountChanged`/`disconnect` equivalents when supported.
- Balance refresh every 30s for real wallets.

## Balances

- **Phantom** (`refreshPhantomBalance`): 3-step — (1) `provider.request({method:"getBalance", params:{pubkey}})` if available, (2) `POST /api/sol-balance` proxy, (3) `provider.getBalance(pubkey)`. Success → SOL; all fail → `null`.
- **MetaMask** (`refreshMetaMaskBalance`): `eth_chainId` → network name (12 known: Ethereum `0x1`, OP, Arbitrum One, Polygon, Base, BNB, Avalanche, Linea, Scroll, Blast, zkSync, Sepolia; else `Chain <id>`), `eth_getBalance([address,"latest"])` → ETH.
- **Demo**: fixed `$24,817.42`; `Notch` shows `bar ≈ demoBalanceUsd / pairPrice` as pseudo units.
- `WalletButton` USD line: SOL balance × `sol-sol` pair price, ETH × `evm-eth`, demo → fixed USD.

## Perp signing (`signPerpOrder`)

```ts
signPerpOrder(ticket: PerpTicket): Promise<{ signature: string; signer: string }>
```

- **Demo / no provider**: 450ms delay → random 130-hex-char `0x…` + signer `address || "demo-signer"`.
- **MetaMask**: `eth_requestAccounts` → `switchToArbitrum()` (best-effort `wallet_switchEthereumChain 0xa4b1`, else `wallet_addEthereumChain` with `https://arb1.arbitrum.io/rpc`, Arbiscan) → `eth_signTypedData_v4([signer, JSON.stringify(ticket.order)])`.
- The signed payload is `ticket.order: PerpOrderPayload` — domain `Trading Desk Perps v1`, chainId `42161`, verifying `0x0…0`, 12 typed fields. **No contract verifies it; execution is local paper.**
- Failures propagate to `executePerpTicket` (`lib/store.tsx`), which reverts `signed → proposed` and surfaces `execError` in `/perps`.

## UI (`components/WalletButton.tsx`)

- Disconnected: `Connect Wallet` → dropdown with `WalletOption` rows (Phantom/MetaMask installed = mint "ready", else "not detected") + `Try demo wallet`; error/fallback hints below.
- Connected `Notch`: pill (icon, name, balance chip / paper USD / truncated balance, network, ▲▼) + dropdown (address + copy, balance + USD, network dot, Refresh / View on Solscan–Etherscan / Disconnect). Outside-click closes; explorer links are `solscan.io/account/<addr>` / `etherscan.io/address/<addr>`.
