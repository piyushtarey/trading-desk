import type { AgentEvent, Analysis, Chain, MarketPair, Opportunity, PerpPosition, PerpTicket, Position, ScheduledJob, Trade } from "./types";
import { mulberry32 } from "./rng";
import { PAIR_SEEDS } from "./market";

const HOUR = 3_600_000;

// Generates a believable 48h of history so dashboard/history screens are alive on first load.
export function seedHistory(now: number, pairs: MarketPair[]) {
  const rng = mulberry32(1337);
  const events: AgentEvent[] = [];
  const analyses: Analysis[] = [];
  const trades: Trade[] = [];
  const opportunities: Opportunity[] = [];
  const tickets: PerpTicket[] = [];

  let seq = 0;
  const id = (p: string) => `${p}_seed${(seq++).toString(36)}`;

  for (let h = 47; h >= 0; h--) {
    const ts = now - h * HOUR - Math.floor(rng() * 120_000);

    // 0-3 opportunities per hour
    const oppCount = Math.floor(rng() * 4);
    for (let i = 0; i < oppCount; i++) {
      const seed = PAIR_SEEDS[Math.floor(rng() * PAIR_SEEDS.length)];
      const pairId = seed.chain === "solana" ? `sol-${seed.base.toLowerCase()}` : `evm-${seed.base.toLowerCase()}`;
      const chain: Chain = seed.chain;
      const symbol = `${seed.base}/${seed.quote}`;
      const opp: Opportunity = {
        id: id("opp"),
        pairId,
        symbol,
        chain,
        foundAt: ts,
        momentum: rng(),
        liquidityScore: rng() * 0.8 + 0.2,
        volRisk: rng(),
        bias: rng() < 0.55 ? "long" : "short",
        status: "pending",
      };
      opportunities.push(opp);

      const momentum = clampPct(opp.momentum * 100 * 1.1 + (rng() - 0.3) * 15);
      const liquidity = clampPct(opp.liquidityScore * 100 + (rng() - 0.5) * 10);
      const volatility = clampPct(60 - opp.volRisk * 55 + (rng() - 0.5) * 10);
      const trend = clampPct(Math.abs((rng() - 0.35) * 8) * 9);
      const final = Math.round(clampPct(momentum * 0.34 + liquidity * 0.22 + volatility * 0.18 + trend * 0.26 + 14));
      const signal = final >= 68 ? "BUY" : final >= 45 ? "WATCH" : "SKIP";
      const confidence = Math.round(clampPct(final + (rng() - 0.5) * 8));

      const analysis: Analysis = {
        id: id("ana"),
        opportunityId: opp.id,
        symbol,
        chain,
        signal,
        confidence,
        breakdown: { momentum, liquidity, volatility, trend, final },
        note:
          signal === "BUY"
            ? `Momentum confirmed on ${seed.base}; depth sufficient for size`
            : signal === "WATCH"
              ? `Borderline setup — waiting for confirmation on ${seed.base}`
              : `Risk/reward unattractive on ${seed.base} right now`,
        at: ts + 30_000,
      };
      analyses.push(analysis);

      events.push({
        id: id("evt"),
        agent: "scout",
        type: "opportunity",
        title: `Spotted ${symbol}`,
        detail: `Momentum ${Math.round(opp.momentum * 100)}% · liq ${Math.round(opp.liquidityScore * 100)}% · queued for analyst`,
        payload: { opportunityId: opp.id, symbol, chain },
        at: ts,
      });

      events.push({
        id: id("evt"),
        agent: "analyst",
        type: signal === "BUY" ? "signal" : "analysis",
        title: `${signal} ${symbol} @ ${confidence}%`,
        detail: analysis.note,
        payload: { analysisId: analysis.id, signal, confidence, breakdown: analysis.breakdown },
        at: ts + 30_000,
      });

      // ~half of BUY signals also produce a perp ticket.
      if (signal === "BUY" && rng() < 0.5) {
        const side: "long" | "short" = opp.bias;
        const lev = Math.round(2 + rng() * 8);
        const sizeUsd = Math.max(500, Math.round(1_500 + (confidence / 100) * 3_500));
        const entry = seed.price * (0.99 + rng() * 0.02);
        const liqDistance = 0.92 / lev;
        const tktAt = ts + 35_000;
        const drift = 0.03 + rng() * 0.03;
        // Tickets from the last ~2 minutes can still be awaiting signature.
        const stillFresh = tktAt + 90_000 > now;
        const roll = rng();
        const status: PerpTicket["status"] = stillFresh
          ? roll < 0.45
            ? "proposed"
            : roll < 0.7
              ? "executed"
              : roll < 0.85
                ? "cancelled"
                : "expired"
          : roll < 0.62
            ? "executed"
            : roll < 0.82
              ? "cancelled"
              : "expired";
        tickets.push({
          id: id("tkt"),
          analysisId: analysis.id,
          opportunityId: opp.id,
          symbol,
          chain,
          side,
          entryPrice: entry,
          sizeUsd,
          leverage: lev,
          notionalUsd: sizeUsd * lev,
          liqPrice: side === "long" ? entry * (1 - liqDistance) : entry * (1 + liqDistance),
          takeProfit: side === "long" ? entry * (1 + drift) : entry * (1 - drift),
          stopLoss: side === "long" ? entry * (1 - drift * 0.6) : entry * (1 + drift * 0.6),
          confidence,
          breakdown: analysis.breakdown,
          note: `${side === "long" ? "Long" : "Short"} bias · lev ${lev}x · risk-sized $${sizeUsd.toLocaleString()}`,
          status,
          createdAt: tktAt,
          expiresAt: tktAt + 90_000,
        });
        events.push({
          id: id("evt"),
          agent: "analyst",
          type: "ticket",
          title: `TICKET ${side.toUpperCase()} ${symbol} ${lev}x`,
          detail: `Entry ${entry.toPrecision(6)} · size $${sizeUsd.toLocaleString()} · expires 90s`,
          payload: { ticketId: tickets[tickets.length - 1].id, symbol, side, leverage: lev },
          at: tktAt,
        });
      }

      if (signal === "BUY" && rng() < 0.7) {
        const notional = 2_500 + rng() * 4_000;
        const entry = seed.price * (0.97 + rng() * 0.06);
        const qty = notional / entry;
        const buyTrade: Trade = {
          id: id("trd"),
          symbol,
          chain,
          side: "buy",
          qty,
          price: entry,
          slippage: 0.02 + rng() * 0.12,
          fee: notional * 0.0004,
          notional,
          at: ts + 45_000,
        };
        trades.push(buyTrade);
        events.push({
          id: id("evt"),
          agent: "executor",
          type: "order",
          title: `BUY ${seed.base} · $${Math.round(notional).toLocaleString()}`,
          detail: `Paper-filled @ ${entry.toPrecision(6)} · slip ${buyTrade.slippage.toFixed(3)}% · fee $${buyTrade.fee.toFixed(2)}`,
          payload: { tradeId: buyTrade.id, symbol, side: "buy", notionalUsd: notional },
          at: ts + 45_000,
        });

        // ~65% of buys get closed within the hour
        if (rng() < 0.65) {
          const holdMinutes = 5 + rng() * 55;
          const move = (rng() - 0.42) * 0.09; // slight positive edge
          const exit = entry * (1 + move);
          const sellTrade: Trade = {
            id: id("trd"),
            symbol,
            chain,
            side: "sell",
            qty,
            price: exit,
            slippage: 0.02 + rng() * 0.1,
            fee: notional * 0.0004,
            notional: qty * exit,
            at: ts + 45_000 + holdMinutes * 60_000,
          };
          trades.push(sellTrade);
          const pnlPct = move * 100;
          events.push({
            id: id("evt"),
            agent: "executor",
            type: "fill",
            title: `SELL ${seed.base} · take-profit`,
            detail: `Closed @ ${exit.toPrecision(6)} · P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
            payload: { symbol, pnlPct: Math.round(pnlPct * 100) / 100 },
            at: sellTrade.at,
          });
        }
      }
    }

    // occasional job + risk + heartbeat noise
    if (rng() < 0.5) {
      events.push({
        id: id("evt"),
        agent: "scout",
        type: "job",
        title: "Job: market scan",
        detail: `Swept ${PAIR_SEEDS.length} pairs across Solana + EVM`,
        at: ts + 60_000,
      });
    }
    if (rng() < 0.35) {
      events.push({
        id: id("evt"),
        agent: "analyst",
        type: "risk",
        title: "Risk sweep clean",
        detail: "Book exposure within limits",
        at: ts + 90_000,
      });
    }
    if (rng() < 0.3) {
      events.push({
        id: id("evt"),
        agent: "scout",
        type: "heartbeat",
        title: "Heartbeat OK",
        detail: "All 3 agents responsive · pipeline latency nominal",
        at: ts + 120_000,
      });
    }
  }

  events.sort((a, b) => b.at - a.at);
  analyses.sort((a, b) => b.at - a.at);
  trades.sort((a, b) => b.at - a.at);
  opportunities.sort((a, b) => b.foundAt - a.foundAt);

  // Open positions: derive from most recent open buys (buys with no matching later sell)
  const openBySymbol = new Map<string, Trade>();
  for (const t of trades) {
    if (t.side === "buy") openBySymbol.set(t.symbol, t);
    else openBySymbol.delete(t.symbol);
  }
  const positions: Position[] = [];
  for (const t of openBySymbol.values()) {
    const pair = pairs.find((p) => p.symbol === t.symbol);
    const mark = pair ? pair.price : t.price;
    const pnlPct = (mark / t.price - 1) * 100;
    positions.push({
      id: id("pos"),
      symbol: t.symbol,
      chain: t.chain,
      side: "long",
      entryPrice: t.price,
      markPrice: mark,
      qty: t.qty,
      notionalUsd: t.qty * t.price,
      openedAt: t.at,
      pnlPct,
      pnl: (t.qty * t.price * pnlPct) / 100,
    });
  }

  // Derive perp positions from executed tickets: older ones mostly closed.
  const perpPositions: PerpPosition[] = [];
  for (const t of [...tickets].sort((a, b) => b.createdAt - a.createdAt)) {
    if (t.status !== "executed") continue;
    const age = now - t.createdAt;
    const pair = pairs.find((p) => p.symbol === t.symbol);
    const mark = pair ? pair.price : t.entryPrice;
    const qty = t.notionalUsd / t.entryPrice;
    const openedAt = t.createdAt + 5_000;
    const stillOpen = age < 30 * 60_000 ? rng() < 0.85 : rng() < 0.3;
    if (stillOpen) {
      const movePct = ((mark / t.entryPrice - 1) * 100) * (t.side === "long" ? 1 : -1) * t.leverage;
      perpPositions.push({
        id: id("pperp"),
        ticketId: t.id,
        symbol: t.symbol,
        chain: t.chain,
        side: t.side,
        qty,
        leverage: t.leverage,
        entryPrice: t.entryPrice,
        markPrice: mark,
        marginUsd: t.sizeUsd,
        notionalUsd: t.notionalUsd,
        liqPrice: t.liqPrice,
        takeProfit: t.takeProfit,
        stopLoss: t.stopLoss,
        pnl: (t.sizeUsd * movePct) / 100,
        pnlPct: movePct,
        openedAt,
        status: "open",
      });
    } else {
      const exitMove = (rng() - 0.42) * (0.06 / t.leverage); // per-price move, slight edge
      const exitPrice = t.entryPrice * (1 + exitMove * (t.side === "long" ? 1 : -1));
      const pnlPct = Math.max(exitMove * 100 * t.leverage, -98);
      const via = pnlPct >= 5.5 * 1 ? (rng() < 0.7 ? "take-profit" : "manual") : pnlPct <= -3.5 ? (rng() < 0.5 ? "stop-loss" : "liquidation") : "manual";
      perpPositions.push({
        id: id("pperp"),
        ticketId: t.id,
        symbol: t.symbol,
        chain: t.chain,
        side: t.side,
        qty,
        leverage: t.leverage,
        entryPrice: t.entryPrice,
        markPrice: exitPrice,
        marginUsd: t.sizeUsd,
        notionalUsd: t.notionalUsd,
        liqPrice: t.liqPrice,
        takeProfit: t.takeProfit,
        stopLoss: t.stopLoss,
        pnl: (t.sizeUsd * pnlPct) / 100,
        pnlPct,
        openedAt,
        status: "closed",
        closedVia: via,
        closedAt: openedAt + (5 + rng() * 90) * 60_000,
        realizedPnl: (t.sizeUsd * pnlPct) / 100,
      });
      events.push({
        id: id("evt"),
        agent: "executor",
        type: "fill",
        title: `${via === "liquidation" ? "LIQUIDATED" : via === "take-profit" ? "TP/SL" : "CLOSE"} ${t.symbol} ${t.leverage}x`,
        detail: `${t.side} closed · ${via} · P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% margin ($${((t.sizeUsd * pnlPct) / 100).toFixed(2)})`,
        payload: { symbol: t.symbol, via, pnlPct: Math.round(pnlPct * 10) / 10 },
        at: openedAt + (5 + rng() * 90) * 60_000,
      });
    }
  }
  perpPositions.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));

  const eventsTrimmed = events.slice(0, 400);
  return {
    events: eventsTrimmed,
    analyses: analyses.slice(0, 200),
    trades: trades.slice(0, 200),
    opportunities: opportunities.slice(0, 60),
    positions,
    tickets: tickets.slice(0, 80),
    perpPositions: perpPositions.slice(0, 40),
  };
}

function clampPct(n: number) {
  return Math.max(0, Math.min(100, n));
}
