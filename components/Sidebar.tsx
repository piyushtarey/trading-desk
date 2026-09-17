"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDesk } from "@/lib/store";

const NAV = [
  { href: "/", label: "Dashboard", icon: "▤" },
  { href: "/agents", label: "Agents", icon: "◇" },
  { href: "/perps", label: "Perps", icon: "⚡" },
  { href: "/history", label: "History", icon: "≣" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { state } = useDesk();
  const running = state.running;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-sky-400 to-violet-400 text-sm font-bold text-ink-950">
          TD
        </div>
        <div>
          <div className="text-sm font-bold tracking-wide">TRADING DESK</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">3-agent sync</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                active ? "bg-ink-700 text-white" : "text-slate-400 hover:bg-ink-800 hover:text-slate-200"
              }`}
            >
              <span className="w-4 text-center">{item.icon}</span>
              {item.label}
              {item.href === "/history" && (
                <span className="ml-auto rounded bg-ink-600 px-1.5 py-0.5 text-[10px] text-slate-300">
                  {state.events.length}
                </span>
              )}
              {item.href === "/perps" && (
                <span className="ml-auto rounded bg-gold-400/10 px-1.5 py-0.5 text-[10px] font-bold text-gold-400">
                  {state.tickets.filter((t) => t.status === "proposed" && t.expiresAt > state.now).length}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-ink-700 p-3">
        <div className="rounded-md border border-ink-700 bg-ink-850 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`anim-pulse-dot inline-block h-2 w-2 rounded-full ${
                running ? "bg-mint-400" : "bg-slate-500"
              }`}
            />
            <span className="text-xs font-semibold text-slate-300">{running ? "Desk running" : "Desk paused"}</span>
          </div>
          <div className="text-[10px] leading-relaxed text-slate-500">
            Paper trading only. No real orders are routed. Mock market data.
          </div>
        </div>
        <div className="mt-2 text-center text-[10px] text-slate-600">mockup v0.1</div>
      </div>
    </aside>
  );
}
