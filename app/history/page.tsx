"use client";

import Link from "next/link";
import HistoryTable from "@/components/HistoryTable";
import { Panel } from "@/components/ui";

export default function HistoryPage() {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">History — all agents</h1>
          <p className="text-xs text-slate-500">Every event from Scout, Analyst and Executor. Click a row to inspect its payload.</p>
        </div>
        <div className="flex gap-2 text-[11px]">
          <Link href="/agents/scout" className="rounded border border-sky-400/40 px-2.5 py-1 text-sky-400 hover:bg-sky-400/10">
            Scout only
          </Link>
          <Link href="/agents/analyst" className="rounded border border-violet-400/40 px-2.5 py-1 text-violet-400 hover:bg-violet-400/10">
            Analyst only
          </Link>
          <Link href="/agents/executor" className="rounded border border-mint-400/40 px-2.5 py-1 text-mint-400 hover:bg-mint-400/10">
            Executor only
          </Link>
        </div>
      </div>

      <Panel title="Combined timeline">
        <HistoryTable pageSize={50} />
      </Panel>
    </div>
  );
}
