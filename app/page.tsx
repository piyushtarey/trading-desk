"use client";

import { useDesk } from "@/lib/store";
import { TICK_MS } from "@/lib/desk";
import { fmtTime } from "@/lib/format";
import KpiCards from "@/components/KpiCards";
import AgentBoard from "@/components/AgentBoard";
import ActivityFeed from "@/components/ActivityFeed";
import ScheduleList from "@/components/ScheduleList";
import PositionsTable from "@/components/PositionsTable";
import { Panel } from "@/components/ui";

export default function DashboardPage() {
  const { state, toggleRunning } = useDesk();

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Dashboard</h1>
          <p className="text-xs text-slate-500">
            Scout → Analyst → Executor sync every {TICK_MS / 1000}s · tick #{state.tick} · clock {fmtTime(state.now)}
          </p>
        </div>
        <button
          onClick={toggleRunning}
          className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
            state.running
              ? "border-gold-400/40 text-gold-400 hover:bg-gold-400/10"
              : "border-mint-400/40 text-mint-400 hover:bg-mint-400/10"
          }`}
        >
          {state.running ? "⏸ Pause desk" : "▶ Resume desk"}
        </button>
      </div>

      <KpiCards />
      <AgentBoard />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Live activity feed" className="xl:col-span-2" bodyClassName="flex flex-col max-h-[420px]">
          <ActivityFeed limit={50} />
        </Panel>

        <Panel title="Scheduled jobs" bodyClassName="max-h-[420px] overflow-y-auto">
          <ScheduleList />
        </Panel>
      </div>

      <Panel title="Open positions">
        <PositionsTable />
      </Panel>
    </div>
  );
}
