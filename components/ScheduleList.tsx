"use client";

import { useEffect, useState } from "react";
import { useDesk } from "@/lib/store";
import { fmtDuration, fmtInterval } from "@/lib/format";
import type { ScheduledJob } from "@/lib/types";

const AGENT_CHIP: Record<string, string> = {
  scout: "bg-sky-400/15 text-sky-400",
  analyst: "bg-violet-400/15 text-violet-400",
  executor: "bg-mint-400/15 text-mint-400",
  system: "bg-slate-400/15 text-slate-400",
};

function useNow(intervalMs = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function ScheduleList() {
  const { state, toggleJob, runJobNow } = useDesk();
  const now = useNow(250);

  return (
    <div className="space-y-2">
      {state.jobs.map((job) => (
        <JobRow key={job.id} job={job} now={now} onPause={() => toggleJob(job.id)} onRun={() => runJobNow(job.id)} />
      ))}
    </div>
  );
}

function JobRow({
  job,
  now,
  onPause,
  onRun,
}: {
  job: ScheduledJob;
  now: number;
  onPause: () => void;
  onRun: () => void;
}) {
  const remaining = job.paused ? job.intervalMs : job.nextRunAt - now;
  const progress = job.paused ? 0 : 1 - Math.max(0, remaining) / job.intervalMs;
  const pct = Math.min(100, Math.max(0, progress * 100));

  return (
    <div className={`rounded-lg border border-ink-700 bg-ink-850 p-3 ${job.paused ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${AGENT_CHIP[job.agent] ?? AGENT_CHIP.system}`}>
            {String(job.agent).toUpperCase()}
          </span>
          <span className="truncate text-xs font-semibold text-slate-200">{job.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onRun}
            title="Run now"
            className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-sky-400/50 hover:text-sky-400"
          >
            ▶ now
          </button>
          <button
            onClick={onPause}
            title={job.paused ? "Resume" : "Pause"}
            className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-gold-400/50 hover:text-gold-400"
          >
            {job.paused ? "resume" : "pause"}
          </button>
        </div>
      </div>

      <div className="mt-1 truncate text-[10px] text-slate-500">{job.description}</div>

      <div className="mt-2 h-1 overflow-hidden rounded bg-ink-700">
        {job.paused ? (
          <div className="h-full w-full bg-ink-600" />
        ) : (
          <div
            className="anim-shimmer h-full rounded bg-sky-400/40"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>
          every {fmtInterval(job.intervalMs)} · {job.runCount} runs
        </span>
        <span className={job.paused ? "text-gold-400" : "text-slate-400"}>
          {job.paused ? "paused" : `next in ${fmtDuration(remaining)}`}
        </span>
      </div>
    </div>
  );
}
