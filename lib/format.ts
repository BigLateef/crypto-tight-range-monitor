export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: d });
}
export function fmtUsd(n: number | null | undefined, sign = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : sign && n > 0 ? "+" : ""}$${s}`;
}
export function fmtPct(n: number | null | undefined, digits = 1, sign = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `${n < 0 ? "-" : sign && n > 0 ? "+" : ""}${Math.abs(n).toFixed(digits)}%`;
}
export function fmtUnits(n: number): string {
  const d = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
