"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PerpTicket } from "./types";

/* ------------------------------------------------------------------ */
/* Wallet types                                                        */
/* ------------------------------------------------------------------ */

export type WalletKind = "phantom" | "metamask" | "demo";

export interface WalletState {
  connected: boolean;
  kind: WalletKind | null;
  address: string | null;
  /** Truncated for display, e.g. "9xQe…pUit" */
  short: string | null;
  /** Live on-chain balance in native units (SOL / ETH), null when unknown */
  balance: number | null;
  /** Native token symbol for the balance */
  balanceSymbol: string | null;
  /** Human network label, e.g. "Mainnet", "Arbitrum One" */
  network: string | null;
  connecting: boolean;
  error: string | null;
  /** True when the provider extension was not detected and we fell back */
  demoFallback: boolean;
  demoBalanceUsd: number | null;
  /** Which Chrome extensions are actually injected in this browser */
  detected: { phantom: boolean; metamask: boolean };
}

interface WalletContextValue extends WalletState {
  connect: (kind: WalletKind) => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  /** Switch the EVM wallet to Arbitrum One (perp execution chain). */
  switchToArbitrum: () => Promise<boolean>;
  /** Sign a typed perp order. Real eth_signTypedData_v4 with MetaMask;
   *  paper signature in demo mode (UI labels it as such). */
  signPerpOrder: (ticket: PerpTicket) => Promise<{ signature: string; signer: string }>;
  /** Send a prepared unsigned transaction (M3 live orders). MetaMask only —
   *  demo and disconnected wallets are rejected. Enforces the expected chain. */
  sendTransaction: (tx: { to: string; data?: string; value?: string; chainId: number }) => Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const LS_KEY = "tradingdesk.wallet.v2";
const LAMPORTS = 1_000_000_000;
const ETH = 1e18;
const DEMO_USD = 24_817.42;
/** M6: the demo wallet exists only in the paper-mode dev harness. Default off. */
const PAPER_MODE = process.env.NEXT_PUBLIC_DESK_PAPER_MODE === "true";

/* ------------------------------------------------------------------ */
/* Injected provider types (minimal)                                   */
/* ------------------------------------------------------------------ */

interface SolanaProvider {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: (b?: "base58") => string } }>;
  disconnect: () => Promise<void>;
  /** Some wallets expose getBalance directly; Phantom instead speaks JSON-RPC. */
  getBalance?: (pk: unknown) => Promise<number>;
  request?: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (ev: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, cb: (...args: unknown[]) => void) => void;
}

interface Eip1193Provider {
  isMetaMask?: boolean;
  isPhantom?: boolean;
  /** MetaMask-only private API — the strongest "really MetaMask" signal. */
  _metamask?: unknown;
  /** MetaMask's multi-provider array (wallet interop). */
  providers?: Eip1193Provider[];
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (ev: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (ev: string, cb: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
    ethereum?: Eip1193Provider;
    /** MetaMask injects an array when several EVM wallets share the provider. */
    providers?: Eip1193Provider[];
  }
}

/* ------------------------------------------------------------------ */
/* EIP-6963 multi-wallet discovery                                     */
/* ------------------------------------------------------------------ */

/**
 * Modern wallet discovery: extensions announce themselves with an rdns key
 * ("io.metamask", "app.phantom", …) so each button always talks to the right
 * extension even when several inject an EVM provider. The listener registers
 * at module load so announcements are never missed.
 */
const eip6963Providers = new Map<string, Eip1193Provider>();

function requestEip6963() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    /* ancient browser — legacy sniffing still applies */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "eip6963:announceProvider",
    ((event: Event) => {
      const detail = (
        event as CustomEvent<{ info?: { rdns?: string }; provider?: Eip1193Provider }>
      ).detail;
      if (detail?.info?.rdns && detail.provider) {
        eip6963Providers.set(detail.info.rdns, detail.provider);
      }
    }) as EventListener,
  );
  requestEip6963(); // ask anything already loaded to announce itself
}

/** Extensions can inject after page load — poll briefly (re-asking EIP-6963)
 *  before falling back to the demo wallet. */
async function waitForProvider<T>(get: () => T | null, timeoutMs = 2500): Promise<T | null> {
  if (get()) return get();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    requestEip6963();
    await new Promise((r) => setTimeout(r, 200));
    if (get()) return get();
  }
  return null;
}

const NETWORKS: Record<string, string> = {
  "0x1": "Ethereum",
  "0xa": "OP Mainnet",
  "0xa4b1": "Arbitrum One",
  "0x89": "Polygon",
  "0x2105": "Base",
  "0x38": "BNB Chain",
  "0xa86a": "Avalanche",
  "0xe708": "Linea",
  "0x82750": "Scroll",
  "0x13e31": "Blast",
  "0x144": "zkSync Era",
  "0xaa36a7": "Sepolia",
};

function getPhantom(): SolanaProvider | null {
  if (typeof window === "undefined") return null;
  // Canonical first; window.solana only when it really is Phantom (other
  // Solana wallets also inject window.solana).
  if (window.phantom?.solana) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}
function getMetaMask(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  // 1) EIP-6963 — unambiguous rdns "io.metamask"; immune to isMetaMask
  //    spoofing (Phantom's EVM provider also sets isMetaMask!).
  const via6963 = eip6963Providers.get("io.metamask");
  if (via6963) return via6963;
  // 2) Legacy injection sniffing across every place a provider can hide.
  const candidates: Eip1193Provider[] = [];
  if (Array.isArray(window.providers)) candidates.push(...window.providers);
  if (window.ethereum) {
    candidates.push(window.ethereum);
    if (Array.isArray(window.ethereum.providers)) candidates.push(...window.ethereum.providers);
  }
  const isMM = (p: Eip1193Provider) => p.isMetaMask && !p.isPhantom;
  // _metamask is MetaMask's private API — spoofing wallets don't have it.
  return candidates.find((p) => isMM(p) && p._metamask) ?? candidates.find(isMM) ?? null;
}

function truncate(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

const WalletContext = createContext<WalletContextValue | null>(null);

const INITIAL: WalletState = {
  connected: false,
  kind: null,
  address: null,
  short: null,
  balance: null,
  balanceSymbol: null,
  network: null,
  connecting: false,
  error: null,
  demoFallback: false,
  demoBalanceUsd: null,
  detected: { phantom: false, metamask: false },
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>(INITIAL);
  /** Guards against setState after unmount in late provider callbacks. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = useCallback((p: Partial<WalletState>) => {
    if (alive.current) setState((s) => ({ ...s, ...p }));
  }, []);

  const persist = useCallback((kind: WalletKind | null) => {
    try {
      if (kind) localStorage.setItem(LS_KEY, kind);
      else localStorage.removeItem(LS_KEY);
    } catch {
      /* private mode — non-fatal */
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Balance refreshers                                               */
  /* ---------------------------------------------------------------- */

  const refreshPhantomBalance = useCallback(
    async (provider: SolanaProvider, address: string) => {
      // 1) Solana JSON-RPC via the wallet provider — respects the cluster
      //    selected in the extension. This is how Phantom actually works;
      //    its provider has NO getBalance() method.
      if (typeof provider.request === "function") {
        try {
          const res = (await provider.request({ method: "getBalance", params: [address] })) as {
            value?: number;
            result?: { value?: number };
          };
          const lamports = res?.value ?? res?.result?.value;
          if (typeof lamports === "number" && Number.isFinite(lamports)) {
            patch({ balance: lamports / LAMPORTS, balanceSymbol: "SOL" });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      // 2) Our server proxy → public mainnet RPC (the RPC blocks browser-origin requests).
      try {
        const res2 = await fetch("/api/sol-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address }),
        });
        if (res2.ok) {
          const j2 = (await res2.json()) as { lamports?: number };
          if (typeof j2.lamports === "number") {
            patch({ balance: j2.lamports / LAMPORTS, balanceSymbol: "SOL" });
            return;
          }
        }
      } catch {
        /* fall through */
      }
      // 3) Legacy wallets that implement getBalance directly.
      if (typeof provider.getBalance === "function") {
        try {
          const lamports = await provider.getBalance(address);
          patch({ balance: lamports / LAMPORTS, balanceSymbol: "SOL" });
          return;
        } catch {
          /* fall through */
        }
      }
      console.warn("[wallet] could not fetch SOL balance for", address);
      patch({ balance: null, balanceSymbol: "SOL" });
    },
    [patch],
  );

  const refreshMetaMaskBalance = useCallback(
    async (provider: Eip1193Provider, address: string) => {
      try {
        const chainId = (await provider.request({ method: "eth_chainId" })) as string;
        const hex = (await provider.request({
          method: "eth_getBalance",
          params: [address, "latest"],
        })) as string;
        patch({
          balance: parseInt(hex, 16) / ETH,
          balanceSymbol: "ETH",
          network: NETWORKS[chainId] ?? `Chain ${chainId}`,
        });
      } catch {
        patch({ balance: null, balanceSymbol: "ETH" });
      }
    },
    [patch],
  );

  const switchToArbitrum = useCallback(async (): Promise<boolean> => {
    const provider = getMetaMask();
    if (!provider) return false;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4b1" }] });
      return true;
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code === 4902 || code === -32603) {
        // Chain not added yet — add Arbitrum One, then we're on it.
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0xa4b1",
                chainName: "Arbitrum One",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://arb1.arbitrum.io/rpc"],
                blockExplorerUrls: ["https://arbiscan.io"],
              },
            ],
          });
          return true;
        } catch {
          return false;
        }
      }
      return false; // user rejected the switch
    }
  }, []);

  const signPerpOrder = useCallback(
    async (ticket: PerpTicket): Promise<{ signature: string; signer: string }> => {
      const provider = getMetaMask();
      // Demo wallet or no MetaMask: paper signature, clearly labeled in the UI.
      if (state.kind === "demo" || !provider) {
        await new Promise((r) => setTimeout(r, 450));
        const hex = "0123456789abcdef";
        const sig =
          "0x" +
          Array.from({ length: 130 }, () => hex[Math.floor(Math.random() * 16)]).join("");
        return { signature: sig, signer: state.address ?? "demo-signer" };
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const signer = accounts?.[0];
      if (!signer) throw new Error("No MetaMask account authorized");
      await switchToArbitrum(); // best effort — signing works from any chain
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [signer, JSON.stringify(ticket.order)],
      })) as string;
      if (!signature) throw new Error("Signature rejected");
      return { signature, signer };
    },
    [state.kind, state.address, switchToArbitrum],
  );

  const sendTransaction = useCallback(
    async (tx: { to: string; data?: string; value?: string; chainId: number }): Promise<string> => {
      const provider = getMetaMask();
      if (state.kind !== "metamask" || !provider) {
        throw new Error("Connect MetaMask to send live transactions (demo wallet cannot move funds)");
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error("Refusing to send: invalid destination address");
      // Enforce the venue chain — never send a prepared tx on the wrong network.
      const wantHex = `0x${tx.chainId.toString(16)}`;
      const current = (await provider.request({ method: "eth_chainId" })) as string;
      if (typeof current === "string" && current.toLowerCase() !== wantHex.toLowerCase()) {
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
        } catch (err) {
          const code = (err as { code?: number })?.code;
          if (code === 4902 || code === -32603) {
            const presets: Record<number, object> = {
              42161: {
                chainId: wantHex,
                chainName: "Arbitrum One",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://arb1.arbitrum.io/rpc"],
                blockExplorerUrls: ["https://arbiscan.io"],
              },
              421614: {
                chainId: wantHex,
                chainName: "Arbitrum Sepolia",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
                blockExplorerUrls: ["https://sepolia.arbiscan.io"],
              },
            };
            const preset = presets[tx.chainId];
            if (!preset) throw new Error(`Unsupported chain ${tx.chainId} — refusing to send`);
            await provider.request({ method: "wallet_addEthereumChain", params: [preset] });
          } else {
            throw new Error("Chain switch rejected — refusing to send on the wrong network");
          }
        }
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts?.[0];
      if (!from) throw new Error("No MetaMask account authorized");
      const params: Record<string, string> = { from, to: tx.to };
      if (tx.data) params.data = tx.data;
      if (tx.value) params.value = tx.value;
      const hash = (await provider.request({ method: "eth_sendTransaction", params: [params] })) as string;
      if (!hash) throw new Error("Transaction rejected");
      return hash;
    },
    [state.kind],
  );

  const refreshBalance = useCallback(async () => {
    if (!state.connected || !state.address || state.kind === "demo") return;
    if (state.kind === "phantom") {
      const provider = getPhantom();
      if (provider) await refreshPhantomBalance(provider, state.address);
    } else if (state.kind === "metamask") {
      const provider = getMetaMask();
      if (provider) await refreshMetaMaskBalance(provider, state.address);
    }
  }, [state.connected, state.address, state.kind, refreshPhantomBalance, refreshMetaMaskBalance]);

  /* ---------------------------------------------------------------- */
  /* Connect                                                          */
  /* ---------------------------------------------------------------- */

  const connect = useCallback(
    async (kind: WalletKind) => {
      patch({ connecting: true, error: null });
      try {
        if (kind === "demo") {
          // M6: demo wallet is a paper-mode dev tool, not a production path.
          if (!PAPER_MODE) throw new Error("Demo wallet is disabled — connect Phantom or MetaMask");
          const addr = "Demo" + Math.random().toString(36).slice(2, 8).toUpperCase() + "…xz";
          patch({
            connected: true,
            kind: "demo",
            address: addr,
            short: addr.slice(0, 9),
            balance: null,
            balanceSymbol: "USD",
            network: "Demo Account",
            connecting: false,
            demoFallback: false,
            demoBalanceUsd: DEMO_USD,
            error: null,
          });
          persist("demo");
          return;
        }

        if (kind === "phantom") {
          const provider = await waitForProvider(getPhantom);
          if (!provider) {
            // M6: no silent demo fallback in production — fail loudly.
            if (!PAPER_MODE) throw new Error("Phantom not detected — install it to connect");
            // Demo fallback — desk must stay explorable without extensions
            const addr = "Demo" + Math.random().toString(36).slice(2, 8).toUpperCase() + "…xz";
            patch({
              connected: true,
              kind: "demo",
              address: addr,
              short: addr.slice(0, 9),
              balance: null,
              balanceSymbol: "USD",
              network: "Demo Account",
              connecting: false,
              demoFallback: true,
              demoBalanceUsd: DEMO_USD,
              error: "Phantom not detected — using demo wallet",
            });
            persist("demo");
            return;
          }
          const res = await provider.connect();
          const address = res.publicKey.toString("base58");
          patch({
            connected: true,
            kind: "phantom",
            address,
            short: truncate(address),
            network: "Solana Mainnet",
            balanceSymbol: "SOL",
            connecting: false,
            demoFallback: false,
            demoBalanceUsd: null,
            error: null,
          });
          persist("phantom");
          await refreshPhantomBalance(provider, address);
          return;
        }

        // metamask
        const provider = await waitForProvider(getMetaMask);
        if (!provider) {
          // M6: no silent demo fallback in production — fail loudly.
          if (!PAPER_MODE) throw new Error("MetaMask not detected — install it to connect");
          const addr = "Demo" + Math.random().toString(36).slice(2, 8).toUpperCase() + "…xz";
          patch({
            connected: true,
            kind: "demo",
            address: addr,
            short: addr.slice(0, 9),
            balance: null,
            balanceSymbol: "USD",
            network: "Demo Account",
            connecting: false,
            demoFallback: true,
            demoBalanceUsd: DEMO_USD,
            error: "MetaMask not detected — using demo wallet",
          });
          persist("demo");
          return;
        }
        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        const address = accounts[0];
        if (!address) throw new Error("No accounts returned");
        patch({
          connected: true,
          kind: "metamask",
          address,
          short: truncate(address),
          balanceSymbol: "ETH",
          connecting: false,
          demoFallback: false,
          demoBalanceUsd: null,
          error: null,
        });
        persist("metamask");
        await refreshMetaMaskBalance(provider, address);
      } catch (err) {
        const msg =
          err instanceof Error && err.message === "No accounts returned"
            ? "No accounts returned"
            : "Connection rejected or failed";
        patch({ connecting: false, error: msg, connected: false, kind: null });
        persist(null);
      }
    },
    [patch, persist, refreshPhantomBalance, refreshMetaMaskBalance],
  );

  const disconnect = useCallback(() => {
    const provider =
      state.kind === "phantom"
        ? getPhantom()
        : state.kind === "metamask"
          ? getMetaMask()
          : null;
    try {
      if (state.kind === "phantom" && provider) {
        (provider as SolanaProvider).disconnect();
      }
    } catch {
      /* ignore */
    }
    persist(null);
    setState({ ...INITIAL });
  }, [state.kind, persist]);

  /* ---------------------------------------------------------------- */
  /* Persistence + provider event listeners                           */
  /* ---------------------------------------------------------------- */

  // Detect installed extensions. They inject asynchronously (and announce via
  // EIP-6963), so scan immediately and keep re-scanning for a few seconds.
  useEffect(() => {
    const scan = () =>
      patch({
        detected: {
          phantom: getPhantom() !== null,
          metamask: getMetaMask() !== null,
        },
      });
    requestEip6963();
    scan();
    const iv = setInterval(scan, 400);
    const stop = setTimeout(() => clearInterval(iv), 6000);
    return () => {
      clearInterval(iv);
      clearTimeout(stop);
    };
  }, [patch]);

  // One-time: restore a demo session immediately (no extension needed).
  // (Real-wallet sessions restore below via onlyIfTrusted / eth_accounts.)
  // M6: demo restore only in the paper-mode harness.
  useEffect(() => {
    if (!PAPER_MODE) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LS_KEY);
    } catch {
      return;
    }
    if (saved !== "demo") return;
    patch({
      connected: true,
      kind: "demo",
      address: "DemoPAPER…xz",
      short: "DemoPAPER…xz",
      balance: null,
      balanceSymbol: "USD",
      network: "Demo Account",
      demoFallback: false,
      demoBalanceUsd: DEMO_USD,
    });
  }, [patch]);

  // One-time: silent reconnect for a previously-trusted session.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LS_KEY);
    } catch {
      return;
    }
    if (!saved || saved === "demo") return;

    (async () => {
      if (saved === "phantom") {
        const provider = await waitForProvider(getPhantom, 3000);
        if (!provider?.connect) return;
        try {
          const res = await provider.connect({ onlyIfTrusted: true });
          const address = res.publicKey.toString("base58");
          patch({
            connected: true,
            kind: "phantom",
            address,
            short: truncate(address),
            network: "Solana Mainnet",
            balanceSymbol: "SOL",
          });
          await refreshPhantomBalance(provider, address);
        } catch {
          /* not trusted yet — user connects manually */
        }
      } else if (saved === "metamask") {
        const provider = await waitForProvider(getMetaMask, 3000);
        if (!provider) return;
        try {
          const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
          if (accounts?.length) {
            patch({
              connected: true,
              kind: "metamask",
              address: accounts[0],
              short: truncate(accounts[0]),
              balanceSymbol: "ETH",
            });
            await refreshMetaMaskBalance(provider, accounts[0]);
          }
        } catch {
          /* ignore */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Provider events: account switch, chain switch, disconnect.
  useEffect(() => {
    if (!state.connected) return;

    if (state.kind === "phantom") {
      const provider = getPhantom();
      if (!provider?.on) return;
      const onAccount = (...args: unknown[]) => {
        const pk = args[0] as { toString?: (b?: "base58") => string } | null;
        if (!pk) {
          setState({ ...INITIAL });
          persist(null);
        } else {
          const address = pk.toString ? pk.toString("base58") : String(pk);
          patch({ address, short: truncate(address) });
        }
      };
      provider.on("accountChanged", onAccount);
      return () => {
        provider.removeListener?.("accountChanged", onAccount);
      };
    }

    if (state.kind === "metamask") {
      const provider = getMetaMask();
      if (!provider?.on) return;
      const onAccounts = (...args: unknown[]) => {
        const accounts = args[0] as string[];
        if (!accounts?.length) {
          setState({ ...INITIAL });
          persist(null);
        } else {
          patch({ address: accounts[0], short: truncate(accounts[0]) });
        }
      };
      const onChain = (...args: unknown[]) => {
        const chainId = args[0] as string;
        patch({ network: NETWORKS[chainId] ?? `Chain ${chainId}` });
      };
      provider.on("accountsChanged", onAccounts);
      provider.on("chainChanged", onChain);
      return () => {
        provider.removeListener?.("accountsChanged", onAccounts);
        provider.removeListener?.("chainChanged", onChain);
      };
    }
  }, [state.connected, state.kind, patch, persist]);

  // Periodic balance refresh (30s) while connected to a real wallet.
  useEffect(() => {
    if (!state.connected || state.kind === "demo") return;
    const t = setInterval(() => {
      void refreshBalance();
    }, 30_000);
    return () => clearInterval(t);
  }, [state.connected, state.kind, refreshBalance]);

  const value = useMemo<WalletContextValue>(
    () => ({ ...state, connect, disconnect, refreshBalance, switchToArbitrum, signPerpOrder, sendTransaction }),
    [state, connect, disconnect, refreshBalance, switchToArbitrum, signPerpOrder, sendTransaction],
  );
  // `detected` rides on state — no extra wiring needed.

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
