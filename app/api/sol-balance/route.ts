/**
 * POST /api/sol-balance  { address: string }
 * -> { lamports: number }
 *
 * Browser-origin requests to the public Solana RPC are blocked (403), so the
 * wallet fallback for SOL balances is proxied through this server route.
 */
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const RPC = "https://api.mainnet-beta.solana.com";

export async function POST(req: NextRequest) {
  let address: string;
  try {
    const body = (await req.json()) as { address?: string };
    address = body.address ?? "";
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Base58 addresses: 32–44 chars, no 0/O/I/l.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return Response.json({ error: "invalid Solana address" }, { status: 400 });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const json = (await res.json()) as { result?: { value?: number }; error?: unknown };
    const lamports = json.result?.value;
    if (typeof lamports !== "number") throw new Error(json.error ? "rpc error" : "no value");
    return Response.json({ lamports });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return Response.json({ error: `balance lookup failed (${msg})` }, { status: 502 });
  }
}
