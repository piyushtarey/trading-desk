"use client";

import Link from "next/link";
import { useDesk } from "@/lib/store";
import { fmtTime } from "@/lib/format";

const AGENTS = [
  {
    id: "scout",
    name: "Trade Scout",
    role: "Market scanner",
    icon: "🔭",
    accent: "text-sky-400",
    border: "hover:border-sky-400/40",
    desc: "Continuously sweeps both ecosystems for momentum, liquidity anomalies and fresh listings. Feeds ranked candidates to the analyst within the same sync tick.",
    duties: ["20s market sweep", "Momentum + liquidity heat detection", "Candidate queue for analyst"],
  },
  {
    id: "analyst",
    name: "Trade Analyst",
    role: "Signal engine",
    icon: "🧠",
    accent: "text-violet-400",
    border: "hover:border-violet-400/40",
    desc: "Scores every candidate on momentum, depth, volatility and trend. Emits BUY / WATCH / SKIP with a confidence level and full scoring breakdown.",
    duties: ["Signal refresh every 20s", "Risk sweep every 2m", "Confidence + breakdown per signal"],
  },
  {
    id: "executor",
    name: "Trade Executor",
    role: "Paper execution",
    icon: "⚡",
    accent: "text-mint-400",
    border: "hover:border-mint-400/40",
    desc: "Routes analyst BUY signals through simulated fills with slippage and fees. Manages open positions, take-profit trims and scheduled rebalancing.",
    duties: ["Signal sweep every 20s", "Portfolio rebalance every 5m", "Paper fills with slippage + fee model"],
  },
] as const;

export default function AgentsPage() {
  const { state } = useDesk();

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-bold">Agents</h1>
        <p className="text-xs text-slate-500">Three agents, one synchronous pipeline.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {AGENTS.map((a) => {
          const runtime = state.agents[a.id];
          const agentEvents = state.events.filter((e) => e.agent === a.id);
          return (
            <Link
              key={a.id}
              href={`/agents/${a.id}`}
              className={`rounded-xl border border-ink-700 bg-ink-900/60 p-4 transition-colors ${a.border}`}
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{a.icon}</span>
                <div>
                  <div className={`text-sm font-bold ${a.accent}`}>{a.name}</div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">{a.role}</div>
                </div>
                <span
                  className={`anim-pulse-dot ml-auto inline-block h-2 w-2 rounded-full ${
                    state.running ? "bg-mint-400" : "bg-slate-500"
                  }`}
                />
              </div>

              <p className="mt-3 text-xs leading-relaxed text-slate-400">{a.desc}</p>

              <ul className="mt-3 space-y-1">
                {a.duties.map((d) => (
                  <li key={d} className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="text-mint-400">✓</span>
                    {d}
                  </li>
                ))}
              </ul>

              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-ink-700 pt-3 text-center">
                <div>
                  <div className="text-sm font-bold text-slate-200">{runtime.cycle}</div>
                  <div className="text-[9px] uppercase text-slate-600">cycles</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-200">{runtime.tasksDone}</div>
                  <div className="text-[9px] uppercase text-slate-600">tasks</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-200">{agentEvents.length}</div>
                  <div className="text-[9px] uppercase text-slate-600">events</div>
                </div>
              </div>

              <div className="mt-2 text-[10px] text-slate-600">last heartbeat {fmtTime(runtime.heartbeatAt)}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
