"use client";

import { useEffect, useState } from "react";
import { MIN_JOB_INTERVAL_MS, useDesk } from "@/lib/store";
import type { JobKind, ScheduledJob } from "@/lib/types";
import { fmtDuration, fmtInterval, fmtTime } from "@/lib/format";
import { Panel } from "@/components/ui";

const MAX_INTERVAL_MS = 86_400_000;

const KIND_META: Record<JobKind, { label: string; desc: string }> = {
  scan: { label: "Market scan", desc: "Sweep pairs for momentum & liquidity anomalies" },
  analysis: { label: "Signal refresh", desc: "Re-score opportunities, expire stale ones" },
  exec: { label: "Signal sweep", desc: "Pick up BUY signals for execution" },
  rebalance: { label: "Portfolio rebalance", desc: "Trim winners, cut losers (CLOSES positions)" },
  risk: { label: "Risk sweep", desc: "Flag drawdown and volatility spikes" },
  heartbeat: { label: "Health heartbeat", desc: "Ping all agents, verify pipeline" },
};

const AGENT_DOT: Record<string, string> = {
  scout: "bg-sky-400",
  analyst: "bg-violet-400",
  executor: "bg-mint-400",
  system: "bg-slate-500",
};

/** "15s" / "2m" / "1.5h" / "500ms" / "30" (seconds) -> ms. Bounds-checked. */
function parseIntervalInput(raw: string): { ok: true; ms: number } | { ok: false; error: string } {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return { ok: false, error: 'Use a number + unit, e.g. 15s, 2m, 1h (default unit: s).' };
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = Math.round(n * mult);
  if (ms < MIN_JOB_INTERVAL_MS) return { ok: false, error: `Minimum interval is ${MIN_JOB_INTERVAL_MS / 1000}s.` };
  if (ms > MAX_INTERVAL_MS) return { ok: false, error: "Maximum interval is 24h." };
  return { ok: true, ms };
}

function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function JobsPage() {
  const { state, toggleJob, runJobNow, updateJobInterval, updateJob, addJob, deleteJob } = useDesk();
  const now = useNow();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="mx-auto w-full max-w-none space-y-4 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Scheduled jobs</h1>
          <p className="mt-1 text-xs text-slate-500">
            {state.jobs.filter((j) => !j.paused).length} of {state.jobs.length} active · edits persist across reloads ·
            timers restart on boot.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md border border-sky-400/50 px-3 py-1.5 text-xs font-bold text-sky-400 hover:bg-sky-400/10"
        >
          {showForm ? "Close" : "+ New job"}
        </button>
      </div>

      {showForm && <AddJobForm onAdd={addJob} onDone={() => setShowForm(false)} />}

      <Panel title="All jobs" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead>
              <tr className="border-b border-ink-700 text-[9px] uppercase tracking-widest text-slate-500">
                <Th>Job</Th>
                <Th>Agent</Th>
                <Th>Every</Th>
                <Th>Next run</Th>
                <Th>Last · Runs</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {state.jobs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    No jobs scheduled — the pipeline is idle. Add one above.
                  </td>
                </tr>
              )}
              {state.jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  now={now}
                  onToggle={() => toggleJob(job.id)}
                  onRun={() => runJobNow(job.id)}
                  onSaveInterval={(ms) => updateJobInterval(job.id, ms)}
                  onSaveMeta={(patch) => updateJob(job.id, patch)}
                  onDelete={() => deleteJob(job.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="border-b border-ink-800/60 px-3 py-2.5 align-top">{children}</td>;
}

function JobRow({
  job,
  now,
  onToggle,
  onRun,
  onSaveInterval,
  onSaveMeta,
  onDelete,
}: {
  job: ScheduledJob;
  now: number;
  onToggle: () => void;
  onRun: () => void;
  onSaveInterval: (ms: number) => void;
  onSaveMeta: (patch: { name?: string; description?: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(job.name);
  const [descDraft, setDescDraft] = useState(job.description);
  const [intervalDraft, setIntervalDraft] = useState("");
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remaining = job.paused ? job.intervalMs : Math.max(0, job.nextRunAt - now);
  const kindMeta = KIND_META[job.kind];

  function saveInterval() {
    const parsed = parseIntervalInput(intervalDraft);
    if (!parsed.ok) {
      setIntervalError(parsed.error);
      return;
    }
    setIntervalError(null);
    onSaveInterval(parsed.ms);
    setIntervalDraft("");
  }

  function saveMeta() {
    if (nameDraft.trim().length === 0) return;
    onSaveMeta({ name: nameDraft, description: descDraft });
    setEditing(false);
  }

  return (
    <tr className="hover:bg-ink-800/30">
      <Td>
        {editing ? (
          <div className="space-y-1.5">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              maxLength={60}
              className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-xs text-slate-200"
            />
            <input
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              maxLength={140}
              placeholder="Description"
              className="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-slate-400"
            />
            <div className="flex gap-1.5">
              <button
                onClick={saveMeta}
                disabled={nameDraft.trim().length === 0}
                className="rounded border border-mint-500/50 px-2 py-0.5 text-[10px] font-bold text-mint-400 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setNameDraft(job.name);
                  setDescDraft(job.description);
                }}
                className="rounded border border-ink-600 px-2 py-0.5 text-[10px] text-slate-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-slate-200">{job.name}</span>
              {job.kind === "rebalance" && (
                <span title="This job closes positions" className="text-[10px] text-gold-400">
                  ⚠
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              {kindMeta.label} · {job.builtIn ? "built-in" : "custom"} · {job.description}
            </div>
          </div>
        )}
      </Td>
      <Td>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${AGENT_DOT[job.agent] ?? "bg-slate-500"}`} />
          {job.agent}
        </span>
      </Td>
      <Td>
        <div className="text-slate-200">{fmtInterval(job.intervalMs)}</div>
        <div className="mt-1 flex items-center gap-1">
          <input
            value={intervalDraft}
            onChange={(e) => {
              setIntervalDraft(e.target.value);
              setIntervalError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveInterval();
            }}
            placeholder="e.g. 45s"
            className="w-20 rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[11px] text-slate-300"
          />
          <button
            onClick={saveInterval}
            disabled={intervalDraft.trim().length === 0}
            className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200 disabled:opacity-40"
          >
            Set
          </button>
        </div>
        {intervalError ? (
          <div className="mt-0.5 text-[10px] text-flame-400">{intervalError}</div>
        ) : (
          intervalDraft.trim().length > 0 && (
            <div className="mt-0.5 text-[10px] text-slate-600">Enter ↵ to apply · resets next run</div>
          )
        )}
      </Td>
      <Td>
        {job.paused ? (
          <span className="text-slate-500">paused</span>
        ) : (
          <span className="text-slate-300">in {fmtDuration(remaining)}</span>
        )}
      </Td>
      <Td>
        <div className="text-slate-300">{job.lastRunAt ? fmtTime(job.lastRunAt) : "—"}</div>
        <div className="text-[10px] text-slate-500">{job.runCount} runs</div>
      </Td>
      <Td>
        <button
          onClick={onToggle}
          className={`rounded border px-2 py-1 text-[10px] font-bold ${
            job.paused
              ? "border-mint-500/50 text-mint-400 hover:bg-mint-500/10"
              : "border-gold-500/50 text-gold-400 hover:bg-gold-500/10"
          }`}
        >
          {job.paused ? "Resume" : "Pause"}
        </button>
      </Td>
      <Td>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={onRun}
            title="Run now"
            className="rounded border border-ink-600 px-2 py-1 text-[10px] text-slate-300 hover:text-slate-100"
          >
            ▶
          </button>
          <button
            onClick={() => setEditing((v) => !v)}
            title="Rename / re-describe"
            className="rounded border border-ink-600 px-2 py-1 text-[10px] text-slate-300 hover:text-slate-100"
          >
            ✎
          </button>
          {confirmingDelete ? (
            <>
              <button
                onClick={onDelete}
                className="rounded border border-flame-500/60 px-2 py-1 text-[10px] font-bold text-flame-400 hover:bg-flame-500/10"
              >
                Confirm{job.builtIn ? " (built-in)" : ""}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="rounded border border-ink-600 px-2 py-1 text-[10px] text-slate-400"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              title="Delete job"
              className="rounded border border-ink-600 px-2 py-1 text-[10px] text-slate-400 hover:border-flame-500/60 hover:text-flame-400"
            >
              🗑
            </button>
          )}
        </div>
        {confirmingDelete && job.kind === "rebalance" && (
          <div className="mt-1 text-[10px] text-gold-400">Rebalance closes positions — deleting stops that.</div>
        )}
      </Td>
    </tr>
  );
}

function AddJobForm({ onAdd, onDone }: { onAdd: (input: { name: string; kind: JobKind; intervalMs: number }) => string | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<JobKind>("scan");
  const [interval, setInterval] = useState("60s");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (name.trim().length === 0) {
      setError("Give the job a name.");
      return;
    }
    const parsed = parseIntervalInput(interval);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const id = onAdd({ name: name.trim(), kind, intervalMs: parsed.ms });
    if (!id) {
      setError("Could not create the job — check the values.");
      return;
    }
    onDone();
  }

  return (
    <Panel title="New job — runs an existing handler on your schedule">
      <div className="grid gap-3 md:grid-cols-4">
        <label className="text-[11px] text-slate-400">
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={60}
            placeholder="e.g. Frequent risk check"
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          />
        </label>
        <label className="text-[11px] text-slate-400">
          Handler
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as JobKind)}
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          >
            {(Object.keys(KIND_META) as JobKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_META[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          Every
          <input
            value={interval}
            onChange={(e) => {
              setInterval(e.target.value);
              setError(null);
            }}
            placeholder="e.g. 60s"
            className="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200"
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            onClick={submit}
            className="rounded border border-mint-500/50 px-3 py-1.5 text-xs font-bold text-mint-400 hover:bg-mint-500/10"
          >
            Create
          </button>
          <button onClick={onDone} className="rounded border border-ink-600 px-3 py-1.5 text-xs text-slate-400">
            Cancel
          </button>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-slate-500">{KIND_META[kind].desc} · min 10s, max 24h.</div>
      {kind === "rebalance" && (
        <div className="mt-1 text-[11px] text-gold-400">⚠ Rebalance closes positions — schedule deliberately.</div>
      )}
      {error && <div className="mt-2 text-xs text-flame-400">{error}</div>}
    </Panel>
  );
}
