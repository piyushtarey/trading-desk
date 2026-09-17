export function fmtUsd(n: number, opts?: { sign?: boolean; compact?: boolean }) {
  const sign = opts?.sign && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (opts?.compact && abs >= 1000) {
    return `${sign}$${compact(abs)}`;
  }
  const digits = abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function compact(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

export function fmtPct(n: number, digits = 2) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtQty(n: number) {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function fmtDateTime(ts: number) {
  return new Date(ts).toLocaleString("en-US", { hour12: false });
}

export function fmtDuration(ms: number) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtInterval(ms: number) {
  if (ms % 60000 === 0) {
    const m = ms / 60000;
    return m === 1 ? "1m" : `${m}m`;
  }
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function shortAddr(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}
