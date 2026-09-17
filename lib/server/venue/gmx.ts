/**
 * GMX v2 venue adapter (M3) — server-only.
 *
 * What it does: validate venue config, quote a MarketIncrease order, and build
 * the UNSIGNED ExchangeRouter.multicall for the user's wallet to send:
 *   multicall([sendWnt(orderVault, fee), sendTokens(usdc, orderVault, margin), createOrder(params)])
 * per https://docs.gmx.io/docs/api/contracts/exchange-router/
 *
 * What it NEVER does: hold keys, sign, or submit. Submission is the user's
 * MetaMask `eth_sendTransaction`; tracking reads the public receipt.
 *
 * Fail-closed rules:
 * - every address comes from env (DESK_GMX_*) — no hardcoded contract addresses
 *   (router addresses in particular change across upgrades; two GMX sources
 *   already disagree — see docs/OPERATIONS.md);
 * - prepare verifies bytecode exists at router/vault/market before building;
 * - chainId must be 42161 (Arbitrum One) or 421614 (Arbitrum Sepolia testnet);
 * - anything missing/invalid -> { ok: false } and the route answers 503.
 */

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  TransactionNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

// OrderType / DecreasePositionSwapType per the gmx-synthetics Order enum
// ordering (MarketSwap=0, LimitSwap=1, MarketIncrease=2, LimitIncrease=3,
// MarketDecrease=4, ...). The prepare endpoint echoes a full human decode so
// any enum drift is reviewable before a wallet ever signs.
const ORDER_TYPE_MARKET_INCREASE = 2;
const ORDER_TYPE_MARKET_DECREASE = 4;
const DECREASE_SWAP_NO_SWAP = 0;
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const EXCHANGE_ROUTER_ABI = [
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    name: "sendWnt",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "sendTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "createOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "addresses",
            type: "tuple",
            components: [
              { name: "receiver", type: "address" },
              { name: "cancellationReceiver", type: "address" },
              { name: "callbackContract", type: "address" },
              { name: "uiFeeReceiver", type: "address" },
              { name: "market", type: "address" },
              { name: "initialCollateralToken", type: "address" },
              { name: "swapPath", type: "address[]" },
            ],
          },
          {
            name: "numbers",
            type: "tuple",
            components: [
              { name: "sizeDeltaUsd", type: "uint256" },
              { name: "initialCollateralDeltaAmount", type: "uint256" },
              { name: "triggerPrice", type: "uint256" },
              { name: "acceptablePrice", type: "uint256" },
              { name: "executionFee", type: "uint256" },
              { name: "callbackGasLimit", type: "uint256" },
              { name: "minOutputAmount", type: "uint256" },
              { name: "validFromTime", type: "uint256" },
            ],
          },
          { name: "orderType", type: "uint8" },
          { name: "decreasePositionSwapType", type: "uint8" },
          { name: "isLong", type: "bool" },
          { name: "shouldUnwrapNativeToken", type: "bool" },
          { name: "autoCancel", type: "bool" },
          { name: "referralCode", type: "bytes32" },
          { name: "dataList", type: "bytes32[]" },
        ],
      },
    ],
    outputs: [{ name: "key", type: "bytes32" }],
  },
] as const;

// ---------- Config ----------

export interface GmxMarketConfig {
  /** Desk symbol, e.g. "ETH/USDC" — must match an OrderIntent symbol. */
  symbol: string;
  market: Address;
  indexToken: Address;
  /** Decimals of the index token (ETH=18) — sets acceptablePrice scaling. */
  indexDecimals: number;
  longToken: Address;
  shortToken: Address;
  /** CoinGecko id used for the independent server-side mark check. */
  priceCoinId: string;
  /** Collateral token for M3 orders (USDC-only; no swaps). */
  collateralToken: Address;
  collateralDecimals: number;
}

export interface GmxConfig {
  chainId: 42161 | 421614;
  rpcUrl: string;
  exchangeRouter: Address;
  orderVault: Address;
  /** Base Router — the spender users approve for sendTokens. */
  router: Address;
  executionFeeWei: bigint;
  slippageBps: number;
  markets: GmxMarketConfig[];
}

function reqAddress(name: string, v: string | undefined): Address {
  if (!v || !isAddress(v)) throw new Error(`${name} missing or not an address`);
  return getAddress(v);
}

function parseMarkets(raw: string | undefined): GmxMarketConfig[] {
  if (!raw) throw new Error("DESK_GMX_MARKETS_JSON missing");
  let arr: unknown;
  try {
    arr = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("DESK_GMX_MARKETS_JSON is not valid JSON");
  }
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("DESK_GMX_MARKETS_JSON must be a non-empty array");
  return arr.map((m, i) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.symbol !== "string" || !/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(r.symbol)) {
      throw new Error(`DESK_GMX_MARKETS_JSON[${i}].symbol invalid`);
    }
    const indexDecimals = r.indexDecimals;
    const collateralDecimals = r.collateralDecimals;
    if (typeof indexDecimals !== "number" || !Number.isInteger(indexDecimals) || indexDecimals < 0 || indexDecimals > 30) {
      throw new Error(`DESK_GMX_MARKETS_JSON[${i}].indexDecimals must be an integer 0..30`);
    }
    if (typeof collateralDecimals !== "number" || !Number.isInteger(collateralDecimals) || collateralDecimals < 0 || collateralDecimals > 30) {
      throw new Error(`DESK_GMX_MARKETS_JSON[${i}].collateralDecimals must be an integer 0..30`);
    }
    if (typeof r.priceCoinId !== "string" || r.priceCoinId.length === 0) {
      throw new Error(`DESK_GMX_MARKETS_JSON[${i}].priceCoinId missing`);
    }
    const tag = `DESK_GMX_MARKETS_JSON[${i}]`;
    return {
      symbol: r.symbol,
      market: reqAddress(`${tag}.market`, typeof r.market === "string" ? r.market : undefined),
      indexToken: reqAddress(`${tag}.indexToken`, typeof r.indexToken === "string" ? r.indexToken : undefined),
      indexDecimals,
      longToken: reqAddress(`${tag}.longToken`, typeof r.longToken === "string" ? r.longToken : undefined),
      shortToken: reqAddress(`${tag}.shortToken`, typeof r.shortToken === "string" ? r.shortToken : undefined),
      priceCoinId: r.priceCoinId,
      collateralToken: reqAddress(`${tag}.collateralToken`, typeof r.collateralToken === "string" ? r.collateralToken : undefined),
      collateralDecimals,
    };
  });
}

export type GmxConfigResult = { ok: true; config: GmxConfig } | { ok: false; error: string };

/** Read + validate venue config. Never throws — returns the reason instead. */
export function getGmxConfig(): GmxConfigResult {
  try {
    const chainId = Number(process.env.DESK_GMX_CHAIN_ID ?? "42161");
    if (chainId !== 42161 && chainId !== 421614) {
      throw new Error("DESK_GMX_CHAIN_ID must be 42161 (Arbitrum One) or 421614 (Arbitrum Sepolia)");
    }
    const rpcUrl = process.env.DESK_GMX_RPC_URL;
    if (!rpcUrl) throw new Error("DESK_GMX_RPC_URL missing");
    const slippageBps = Number(process.env.DESK_GMX_SLIPPAGE_BPS ?? "50");
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) {
      throw new Error("DESK_GMX_SLIPPAGE_BPS must be an integer 1..1000");
    }
    let executionFeeWei = 800_000_000_000_000n; // 0.0008 ETH default; excess is refunded to the order account
    const feeRaw = process.env.DESK_GMX_EXECUTION_FEE_WEI;
    if (feeRaw !== undefined && feeRaw !== "") {
      try {
        executionFeeWei = BigInt(feeRaw);
      } catch {
        throw new Error("DESK_GMX_EXECUTION_FEE_WEI must be an integer (wei)");
      }
      if (executionFeeWei <= 0n) throw new Error("DESK_GMX_EXECUTION_FEE_WEI must be positive");
    }
    return {
      ok: true,
      config: {
        chainId,
        rpcUrl,
        exchangeRouter: reqAddress("DESK_GMX_EXCHANGE_ROUTER", process.env.DESK_GMX_EXCHANGE_ROUTER),
        orderVault: reqAddress("DESK_GMX_ORDER_VAULT", process.env.DESK_GMX_ORDER_VAULT),
        router: reqAddress("DESK_GMX_ROUTER", process.env.DESK_GMX_ROUTER),
        executionFeeWei,
        slippageBps,
        markets: parseMarkets(process.env.DESK_GMX_MARKETS_JSON),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid venue config" };
  }
}

function publicClient(config: GmxConfig) {
  return createPublicClient({
    chain: config.chainId === 42161 ? arbitrum : arbitrumSepolia,
    transport: http(config.rpcUrl, { timeout: 6000 }),
  });
}

/**
 * On-chain sanity: every address we will send to must host bytecode.
 * Catches wrong-chain / typo / post-upgrade-stale addresses before building.
 */
export async function assertContractsDeployed(config: GmxConfig, market: Address): Promise<void> {
  const client = publicClient(config);
  const targets: Array<[string, Address]> = [
    ["exchangeRouter", config.exchangeRouter],
    ["orderVault", config.orderVault],
    ["router", config.router],
    ["market", market],
  ];
  for (const [name, addr] of targets) {
    let code: Hex | undefined;
    try {
      code = await client.getBytecode({ address: addr });
    } catch (err) {
      throw new Error(`RPC unreachable while checking ${name} (${err instanceof Error ? err.message : "unknown"})`);
    }
    if (!code || code === "0x") throw new Error(`${name} ${addr} has no contract code — wrong chain or stale address`);
  }
}

// ---------- Quote ----------

export interface GmxQuote {
  notionalUsd: number;
  sizeDeltaUsd: bigint; // 30-decimal USD
  collateralAmount: bigint; // collateral token units
  acceptablePriceUsd: number;
  acceptablePrice: bigint; // contract price format: usd * 10^(30-indexDecimals)
  executionFeeWei: bigint;
}

/** Pure math — no RPC. acceptablePrice gives the keeper slippageBps room. */
export function quoteIncrease(
  market: GmxMarketConfig,
  side: "long" | "short",
  marginUsd: number,
  leverage: number,
  markPriceUsd: number,
  slippageBps: number,
  executionFeeWei: bigint,
): GmxQuote {
  const notionalUsd = marginUsd * leverage;
  const sizeDeltaUsd = BigInt(Math.round(notionalUsd * 1e6)) * 10n ** 24n;
  const collateralAmount = BigInt(Math.round(marginUsd * 10 ** market.collateralDecimals));
  const slip = slippageBps / 10_000;
  const acceptablePriceUsd = side === "long" ? markPriceUsd * (1 + slip) : markPriceUsd * (1 - slip);
  const acceptablePrice =
    BigInt(Math.round(acceptablePriceUsd * 1e6)) * 10n ** BigInt(24 - market.indexDecimals);
  return { notionalUsd, sizeDeltaUsd, collateralAmount, acceptablePriceUsd, acceptablePrice, executionFeeWei };
}

// ---------- Build ----------

export interface PreparedGmxOrder {
  chainId: number;
  /** Unsigned transaction for the wallet to send (value in wei, decimal string). */
  tx: { to: Address; data: Hex; value: string };
  approvals: Array<{ token: Address; spender: Address; amount: string; note: string }>;
  quote: {
    notionalUsd: number;
    sizeDeltaUsd: string;
    collateralAmount: string;
    acceptablePriceUsd: number;
    executionFeeEth: string;
  };
  /** Human-readable decode of exactly what the calldata does — review before signing. */
  decode: {
    venue: "gmx-v2";
    calls: string[];
    market: Address;
    account: Address;
    side: "long" | "short";
    isLong: boolean;
    orderType: "MarketIncrease" | "MarketDecrease";
    swapPath: string;
  };
}

/** Build the unsigned multicall. Pure (no RPC) — call assertContractsDeployed first. */
export function buildIncreaseMulticall(
  config: GmxConfig,
  market: GmxMarketConfig,
  account: Address,
  side: "long" | "short",
  quote: GmxQuote,
): PreparedGmxOrder {
  const sendWnt = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "sendWnt",
    args: [config.orderVault, quote.executionFeeWei],
  });
  const sendTokens = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "sendTokens",
    args: [market.collateralToken, config.orderVault, quote.collateralAmount],
  });
  const createOrder = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "createOrder",
    args: [
      {
        addresses: {
          receiver: account,
          cancellationReceiver: account,
          callbackContract: ZERO_ADDRESS,
          uiFeeReceiver: ZERO_ADDRESS,
          market: market.market,
          initialCollateralToken: market.collateralToken,
          swapPath: [],
        },
        numbers: {
          sizeDeltaUsd: quote.sizeDeltaUsd,
          initialCollateralDeltaAmount: quote.collateralAmount,
          triggerPrice: 0n,
          acceptablePrice: quote.acceptablePrice,
          executionFee: quote.executionFeeWei,
          callbackGasLimit: 0n,
          minOutputAmount: 0n,
          validFromTime: 0n,
        },
        orderType: ORDER_TYPE_MARKET_INCREASE,
        decreasePositionSwapType: DECREASE_SWAP_NO_SWAP,
        isLong: side === "long",
        shouldUnwrapNativeToken: false,
        autoCancel: false,
        referralCode: ZERO_HASH,
        dataList: [],
      },
    ],
  });
  const data = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "multicall",
    args: [[sendWnt, sendTokens, createOrder]],
  });
  return {
    chainId: config.chainId,
    tx: { to: config.exchangeRouter, data, value: quote.executionFeeWei.toString() },
    approvals: [
      {
        token: market.collateralToken,
        spender: config.router,
        amount: quote.collateralAmount.toString(),
        note: "Approve the GMX Router to pull collateral before sending (one-time per amount).",
      },
    ],
    quote: {
      notionalUsd: quote.notionalUsd,
      sizeDeltaUsd: quote.sizeDeltaUsd.toString(),
      collateralAmount: quote.collateralAmount.toString(),
      acceptablePriceUsd: quote.acceptablePriceUsd,
      executionFeeEth: (Number(quote.executionFeeWei) / 1e18).toString(),
    },
    decode: {
      venue: "gmx-v2",
      calls: [
        "sendWnt(orderVault, executionFee)",
        "sendTokens(collateral, orderVault, margin)",
        "createOrder(MarketIncrease)",
      ],
      market: market.market,
      account,
      side,
      isLong: side === "long",
      orderType: "MarketIncrease",
      swapPath: "none (USDC collateral, no swap)",
    },
  };
}

// ---------- Decrease (exits) ----------

export interface GmxDecreaseQuote {
  sizeDeltaUsd: number;
  sizeDelta: bigint; // 30-decimal USD
  collateralDelta: bigint; // collateral token units to withdraw
  acceptablePriceUsd: number;
  acceptablePrice: bigint; // contract price format
  executionFeeWei: bigint;
}

/**
 * Quote a MarketDecrease. Pure math — no RPC. Closing a long sells, so the
 * acceptable price sits BELOW mark; closing a short buys, so it sits ABOVE.
 * minOutputAmount stays 0: acceptablePrice is the guard for exits.
 */
export function quoteDecrease(
  market: GmxMarketConfig,
  side: "long" | "short",
  sizeDeltaUsd: number,
  collateralDeltaUsd: number,
  markPriceUsd: number,
  slippageBps: number,
  executionFeeWei: bigint,
): GmxDecreaseQuote {
  const sizeDelta = BigInt(Math.round(sizeDeltaUsd * 1e6)) * 10n ** 24n;
  const collateralDelta = BigInt(Math.round(collateralDeltaUsd * 10 ** market.collateralDecimals));
  const slip = slippageBps / 10_000;
  const acceptablePriceUsd = side === "long" ? markPriceUsd * (1 - slip) : markPriceUsd * (1 + slip);
  const acceptablePrice =
    BigInt(Math.round(acceptablePriceUsd * 1e6)) * 10n ** BigInt(24 - market.indexDecimals);
  return { sizeDeltaUsd, sizeDelta, collateralDelta, acceptablePriceUsd, acceptablePrice, executionFeeWei };
}

/**
 * Build the unsigned decrease multicall. Unlike increase there is NO
 * sendTokens — position collateral is already locked in the vault; only the
 * execution fee rides along. No approvals needed either.
 */
export function buildDecreaseMulticall(
  config: GmxConfig,
  market: GmxMarketConfig,
  account: Address,
  side: "long" | "short",
  quote: GmxDecreaseQuote,
): PreparedGmxOrder {
  const sendWnt = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "sendWnt",
    args: [config.orderVault, quote.executionFeeWei],
  });
  const createOrder = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "createOrder",
    args: [
      {
        addresses: {
          receiver: account,
          cancellationReceiver: account,
          callbackContract: ZERO_ADDRESS,
          uiFeeReceiver: ZERO_ADDRESS,
          market: market.market,
          initialCollateralToken: market.collateralToken,
          swapPath: [],
        },
        numbers: {
          sizeDeltaUsd: quote.sizeDelta,
          initialCollateralDeltaAmount: quote.collateralDelta,
          triggerPrice: 0n,
          acceptablePrice: quote.acceptablePrice,
          executionFee: quote.executionFeeWei,
          callbackGasLimit: 0n,
          minOutputAmount: 0n,
          validFromTime: 0n,
        },
        orderType: ORDER_TYPE_MARKET_DECREASE,
        decreasePositionSwapType: DECREASE_SWAP_NO_SWAP,
        isLong: side === "long",
        shouldUnwrapNativeToken: false,
        autoCancel: false,
        referralCode: ZERO_HASH,
        dataList: [],
      },
    ],
  });
  const data = encodeFunctionData({
    abi: EXCHANGE_ROUTER_ABI,
    functionName: "multicall",
    args: [[sendWnt, createOrder]],
  });
  return {
    chainId: config.chainId,
    tx: { to: config.exchangeRouter, data, value: quote.executionFeeWei.toString() },
    approvals: [],
    quote: {
      notionalUsd: quote.sizeDeltaUsd,
      sizeDeltaUsd: quote.sizeDelta.toString(),
      collateralAmount: quote.collateralDelta.toString(),
      acceptablePriceUsd: quote.acceptablePriceUsd,
      executionFeeEth: (Number(quote.executionFeeWei) / 1e18).toString(),
    },
    decode: {
      venue: "gmx-v2",
      calls: ["sendWnt(orderVault, executionFee)", "createOrder(MarketDecrease)"],
      market: market.market,
      account,
      side,
      isLong: side === "long",
      orderType: "MarketDecrease",
      swapPath: "none (straight close, no swap)",
    },
  };
}

// ---------- Receipt ----------
export type TxStatus = "pending" | "success" | "reverted";

export interface TxReceiptSummary {
  status: TxStatus;
  blockNumber: number | null;
  txHash: Hex;
}

/**
 * Read the public receipt. `pending` covers both in-mempool and unknown-hash —
 * creation on GMX is async (keepers execute seconds/minutes after creation),
 * so callers must poll and must NOT treat creation as a fill.
 */
export async function getTxReceipt(config: GmxConfig, txHash: string): Promise<TxReceiptSummary> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex string");
  const client = publicClient(config);
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    return {
      status: receipt.status === "success" ? "success" : "reverted",
      blockNumber: receipt.blockNumber !== null ? Number(receipt.blockNumber) : null,
      txHash: txHash as Hex,
    };
  } catch (err) {
    // Unknown/in-flight hashes surface differently across viem versions and
    // RPCs (TransactionNotFoundError vs "could not be found" text) — both mean
    // "no receipt yet", i.e. pending, never an error.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
    if (err instanceof TransactionNotFoundError || /could not be found|not be processed|not found/i.test(msg)) {
      return { status: "pending", blockNumber: null, txHash: txHash as Hex };
    }
    throw new Error(`receipt lookup failed (${err instanceof Error ? err.message : "unknown"})`);
  }
}
