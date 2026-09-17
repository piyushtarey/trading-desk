"use client";

import Link from "next/link";
import { useDesk } from "@/lib/store";
import { fmtTime } from "@/lib/format";
import type { AgentId } from "@/lib/types";

const META: Record<AgentId, { name: string; role: string; accent: string; icon: string }> = {
  scout: { name: "Trade Scout", role: "Market scanner", accent: "text-sky-400", icon: "🔭" },
  analyst: { name: "Trade Analyst", role: "Signal engine", accent: "text-violet-400", icon: "🧠" },
  executor: { name: "Trade Executor", role: "Paper execution", accent: "text-mint-400", icon: "⚡" },
};

const AGENT_ORDER: AgentId[] = ["scout", "analyst", "executor"];

const STATE_LABEL: Record<string, string> = {
  idle: "Ready",
  scanning: "Scanning",
  analyzing: "Scoring",
  executing: "Routing",
  waiting: "Waiting",
};

export default function AgentBoard() {
  const { state } = useDesk();

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {AGENT_ORDER.map((id, idx) => {
        const agent = state.agents[id];
        const meta = META[id];
        const eventsForAgent = state.events.filter((e) => e.agent === id);
        const last = eventsForAgent[0];
        return (
          <div key={id} className="relative flex">
            <Link
              href={`/agents/${id}`}
              className="group flex-1 rounded-lg border border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-600"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-lg ${id === "analyst" && agent.state === "analyzing" ? "anim-spin-slow" : ""}`}>
                    {meta.icon}
                  </span>
                  <div>
                    <div className={`text-sm font-bold ${meta.accent}`}>{meta.name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">{meta.role}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`anim-pulse-dot inline-block h-2 w-2 rounded-full ${
                      state.running ? "bg-mint-400" : "bg-slate-500"
                    }`}
                  />
                  <span className="text-[10px] font-semibold text-slate-400">
                    {state.running ? STATE_LABEL[agent.state] ?? agent.state : "Paused"}
                  </span>
                </div>
              </div>

              <div className="mt-3 rounded bg-ink-850 px-2.5 py-2">
                <div className="flex items-center gap-2 text-[11px] text-slate-300">
                  <span className="text-slate-500">task:</span>
                  <span className="truncate">{agent.currentTask}</span>
                </div>
                {state.running && (
                  <div className="mt-1.5 h-0.5 overflow-hidden rounded bg-ink-700">
                    <div className="anim-scanline h-full w-1/3 rounded bg-sky-400/70" />
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="anim-heartbeat flex h-4 items-center text-mint-400/80">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <span key={i} style={{ height: `${6 + ((i * 5) % 10)}px` }} />
                  ))}
                </div>
                <span className="text-[10px] text-slate-500">
                  hb {state.running ? fmtTime(agent.heartbeatAt) : "—"}
                </span>
              </div>

              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                <span>cycle #{agent.cycle}</span>
                <span>{agent.tasksDone} tasks</span>
              </div>

              <div className="mt-2 border-t border-ink-700 pt-2 text-[11px] text-slate-400">
                <span className="text-slate-500">last: </span>
                {agent.lastOutput}
              </div>
              {last && (
                <div className="mt-1 truncate text-[10px] text-slate-500" title={last.title}>
                  ↳ {last.title} · {fmtTime(last.at)}
                </div>
              )}
            </Link>
            {idx < 2 && (
              <div className="pointer-events-none absolute -right-2.5 top-1/2 z-10 hidden -translate-y-1/2 text-slate-600 md:block">
                →
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
