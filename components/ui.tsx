import type { ReactNode } from "react";

export function Panel({
  title,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`rounded-xl border border-ink-700 bg-ink-900/60 ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400">{title}</h2>
          {action}
        </div>
      )}
      <div className={`p-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
