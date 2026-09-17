"use client";

import { use } from "react";
import Link from "next/link";
import { useDesk } from "@/lib/store";
import { fmtTime } from "@/lib/format";
import type { AgentId } from "@/lib/types";
import ActivityFeed from "@/components/ActivityFeed";
import HistoryTable from "@/components/HistoryTable";
import LlmAnalystPanel from "@/components/LlmAnalystPanel";
import { Panel } from "@/components/ui";

const META: Record<AgentId, { name: string; role: string; accent: string; icon: string }> = {
  scout: { name: "Trade Scout", role: "Market scanner", accent: "text-sky-400", icon: "🔭" },
  analyst: { name: "Trade Analyst", role: "Signal engine", accent: "text-violet-400", icon: "🧠" },
  executor: { name: "Trade Executor", role: "Paper execution", accent: "text-mint-400", icon: "⚡" },
};

const AGENT_ORDER: AgentId[] = ["scout", "analyst", "executor"];

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { state } = useDesk();

  if (!AGENT_ORDER.includes(id as AgentId)) {
    return (
      <div className="p-8 text-center text-sm text-slate-500">
        Unknown agent &quot;{id}&quot;. <Link href="/agents" className="text-sky-400">Back to agents</Link>
      </div>
    );
  }

  const agentId = id as AgentId;
  const meta = META[agentId];
  const runtime = state.agents[agentId];
  const agentEvents = state.events.filter((e) => e.agent === agentId);
  const signals = state.analyses.slice(0, 8);
  const fills = state.trades.slice(0, 8);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{meta.icon}</span>
        <div>
          <h1 className={`text-lg font-bold ${meta.accent}`}>{meta.name}</h1>
          <p className="text-xs text-slate-500">{meta.role} · tick #{state.tick}</p>
        </div>
        <div className="ml-auto flex gap-2">
          {AGENT_ORDER.filter((a) => a !== agentId).map((other) => (
            <Link
              key={other}
              href={`/agents/${other}`}
              className="rounded border border-ink-600 px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-200"
            >
              {META[other].name} →
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="State" value={state.running ? runtime.state : "paused"} />
        <Stat label="Cycles" value={String(runtime.cycle)} />
        <Stat label="Tasks done" value={String(runtime.tasksDone)} />
        <Stat label="Events logged" value={String(agentEvents.length)} />
      </div>

      {/* LLM advisory (renders only when a model is configured) */}
      {agentId === "analyst" && <LlmAnalystPanel />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Current task" bodyClassName="space-y-3">
          <div className="rounded bg-ink-850 px-3 py-2.5 text-xs text-slate-300">{runtime.currentTask}</div>
          <div className="rounded bg-ink-850 px-3 py-2.5 text-xs text-slate-400">
            <span className="text-slate-600">last output: </span>
            {runtime.lastOutput}
          </div>
          <div className="rounded bg-ink-850 px-3 py-2.5 text-xs text-slate-400">
            <span className="text-slate-600">heartbeat: </span>
            {fmtTime(runtime.heartbeatAt)}
          </div>
        </Panel>

        <Panel title="Recent signal scores" className="xl:col-span-2">
          <SignalList analyses={signals} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Recent fills" className="xl:col-span-2">
          <FillList trades={fills} />
        </Panel>

        <Panel title="This agent's stream" bodyClassName="flex flex-col max-h-[360px]">
          <ActivityFeed limit={30} showAgent={false} />
        </Panel>
      </div>

      <Panel title="Full event history">
        <HistoryTable agent={agentId} pageSize={25} />
      </Panel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold capitalize text-slate-100">{value}</div>
    </div>
  );
}

function SignalList({
  analyses,
}: {
  analyses: { id: string; symbol: string; signal: string; confidence: number; breakdown: { momentum: number; liquidity: number; volatility: number; trend: number; final: number }; note: string; at: number }[];
}) {
  if (analyses.length === 0) return <div className="text-xs text-slate-500">No signals yet</div>;
  return (
    <div className="space-y-1.5">
      {analyses.map((a) => (
        <div key={a.id} className="flex items-center gap-3 rounded border border-ink-700 bg-ink-850 px-3 py-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
              a.signal === "BUY"
                ? "bg-mint-400/15 text-mint-400"
                : a.signal === "WATCH"
                  ? "bg-gold-400/15 text-gold-400"
                  : "bg-ink-600 text-slate-400"
            }`}
          >
            {a.signal}
          </span>
          <span className="text-xs font-semibold text-slate-200">{a.symbol}</span>
          <span className="text-[11px] text-slate-500">{a.confidence}% conf</span>
          <span className="ml-auto hidden gap-2 text-[10px] text-slate-500 md:flex">
            <span>M {a.breakdown.momentum}</span>
            <span>L {a.breakdown.liquidity}</span>
            <span>V {a.breakdown.volatility}</span>
            <span>T {a.breakdown.trend}</span>
            <span className="text-slate-300">Σ {a.breakdown.final}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function FillList({
  trades,
}: {
  trades: { id: string; symbol: string; side: string; qty: number; price: number; notional: number; slippage: number; at: number }[];
}) {
  if (trades.length === 0) return <div className="text-xs text-slate-500">No fills yet</div>;
  return (
    <div className="space-y-1.5">
      {trades.map((t) => (
        <div key={t.id} className="flex items-center gap-3 rounded border border-ink-700 bg-ink-850 px-3 py-2 text-xs">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
              t.side === "buy" ? "bg-mint-400/15 text-mint-400" : "bg-flame-400/15 text-flame-400"
            }`}
          >
            {t.side.toUpperCase()}
          </span>
          <span className="font-semibold text-slate-200">{t.symbol}</span>
          <span className="tabular-nums text-slate-400">
            {t.qty.toPrecision(4)} @ {t.price.toPrecision(6)}
          </span>
          <span className="ml-auto tabular-nums text-slate-500">
            ${Math.round(t.notional).toLocaleString()} · slip {t.slippage.toFixed(3)}% · {fmtTime(t.at)}
          </span>
        </div>
      ))}
    </div>
  );
}
