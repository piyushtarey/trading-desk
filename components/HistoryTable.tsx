"use client";

import { useMemo, useState } from "react";
import { useDesk } from "@/lib/store";
import { fmtDateTime } from "@/lib/format";
import type { AgentEvent, AgentId } from "@/lib/types";

const AGENT_META: Record<AgentId, { label: string; chip: string }> = {
  scout: { label: "SCOUT", chip: "bg-sky-400/15 text-sky-400" },
  analyst: { label: "ANALYST", chip: "bg-violet-400/15 text-violet-400" },
  executor: { label: "EXEC", chip: "bg-mint-400/15 text-mint-400" },
};

const TYPE_FILTERS = ["all", "opportunity", "signal", "ticket", "order", "fill", "job", "risk", "heartbeat"] as const;

export default function HistoryTable({
  agent,
  pageSize = 50,
}: {
  agent?: AgentId;
  pageSize?: number;
}) {
  const { state } = useDesk();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  const events = useMemo(() => {
    let list: AgentEvent[] = state.events;
    if (agent) list = list.filter((e) => e.agent === agent);
    if (typeFilter !== "all") list = list.filter((e) => e.type === typeFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (e) => e.title.toLowerCase().includes(q) || e.detail.toLowerCase().includes(q) || e.type.includes(q)
      );
    }
    return list;
  }, [state.events, agent, typeFilter, query]);

  const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = events.slice(safePage * pageSize, safePage * pageSize + pageSize);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t}
            onClick={() => {
              setTypeFilter(t);
              setPage(0);
            }}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
              typeFilter === t
                ? "border-sky-400/60 bg-sky-400/10 text-sky-400"
                : "border-ink-600 text-slate-500 hover:border-ink-600 hover:text-slate-300"
            }`}
          >
            {t}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Search events…"
          className="ml-auto w-48 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-ink-700">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-850 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2 font-medium">Time</th>
              {!agent && <th className="px-3 py-2 font-medium">Agent</th>}
              <th className="px-3 py-2 font-medium">Event</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              const meta = AGENT_META[e.agent];
              const isOpen = expanded.has(e.id);
              return (
                <Row
                  key={e.id}
                  e={e}
                  meta={meta}
                  showAgent={!agent}
                  isOpen={isOpen}
                  onToggle={() => toggle(e.id)}
                />
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                  No events match the current filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>
          {events.length} event{events.length === 1 ? "" : "s"} · page {safePage + 1}/{pageCount}
        </span>
        <div className="flex gap-2">
          <button
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            className="rounded border border-ink-600 px-2 py-1 hover:text-slate-200 disabled:opacity-40"
          >
            ← prev
          </button>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
            className="rounded border border-ink-600 px-2 py-1 hover:text-slate-200 disabled:opacity-40"
          >
            next →
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  e,
  meta,
  showAgent,
  isOpen,
  onToggle,
}: {
  e: AgentEvent;
  meta: { label: string; chip: string };
  showAgent: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-ink-800 last:border-0 transition-colors hover:bg-ink-850/60 ${
          isOpen ? "bg-ink-850" : ""
        }`}
      >
        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{fmtDateTime(e.at)}</td>
        {showAgent && (
          <td className="px-3 py-2">
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${meta.chip}`}>{meta.label}</span>
          </td>
        )}
        <td className="px-3 py-2 font-medium text-slate-200">{e.title}</td>
        <td className="px-3 py-2">
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[9px] uppercase text-slate-400">{e.type}</span>
        </td>
        <td className="max-w-[280px] truncate px-3 py-2 text-right text-slate-500" title={e.detail}>
          {e.detail}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-ink-800 bg-ink-900 last:border-0">
          <td colSpan={5} className="px-3 pb-3 pt-1">
            <div className="rounded border border-ink-700 bg-ink-950 p-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-slate-600">payload</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-sky-300/90">
                {e.payload ? JSON.stringify(e.payload, null, 2) : "— no structured payload —"}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
