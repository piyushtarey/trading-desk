"use client";

import { useDesk } from "@/lib/store";
import { fmtTime } from "@/lib/format";
import type { AgentEvent, AgentId } from "@/lib/types";

const AGENT_META: Record<AgentId, { label: string; chip: string }> = {
  scout: { label: "SCOUT", chip: "bg-sky-400/15 text-sky-400" },
  analyst: { label: "ANALYST", chip: "bg-violet-400/15 text-violet-400" },
  executor: { label: "EXEC", chip: "bg-mint-400/15 text-mint-400" },
};

export default function ActivityFeed({ limit = 40, showAgent = true }: { limit?: number; showAgent?: boolean }) {
  const { state } = useDesk();
  const events = state.events.slice(0, limit);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto pr-1">
        {events.map((e, i) => (
          <FeedRow key={e.id} e={e} showAgent={showAgent} fresh={i === 0 && state.running} />
        ))}
        {events.length === 0 && <div className="p-4 text-center text-xs text-slate-500">No events yet</div>}
      </div>
    </div>
  );
}

function FeedRow({ e, showAgent, fresh }: { e: AgentEvent; showAgent: boolean; fresh: boolean }) {
  const meta = AGENT_META[e.agent];
  return (
    <div
      className={`flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-ink-700 hover:bg-ink-850 ${
        fresh ? "anim-feed-in" : ""
      }`}
    >
      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${meta.chip}`}>{meta.label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium text-slate-200">{e.title}</span>
          <span className="shrink-0 text-[10px] text-slate-600">{fmtTime(e.at)}</span>
        </div>
        <div className="truncate text-[11px] text-slate-500">{e.detail}</div>
      </div>
      {showAgent && null}
    </div>
  );
}
