// Pure formatting helpers for the UI. Deliberately free of any DOM access so
// they can be unit-tested directly with the Node test runner.

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Human-readable byte count, e.g. 1536 -> "1.5 KiB". */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const label = SIZE_UNITS[unit] ?? 'B';
  return unit === 0
    ? `${Math.round(value)} ${label}`
    : `${value.toFixed(1)} ${label}`;
}

/** Compact elapsed-time label, e.g. 5000 -> "5s", 90000 -> "1.5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Relative timestamp, e.g. "just now", "3m ago", "2d ago". */
export function formatRelativeTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  if (epochMs <= 0) return 'unknown';
  const deltaMs = now - epochMs;
  if (deltaMs < 45_000) return 'just now';
  const minutes = deltaMs / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Used / total with a percentage, e.g. "1.0 GiB / 4.0 GiB (25%)". */
export function formatUsage(used: number, total: number): string {
  if (total <= 0) return 'unknown';
  const pct = Math.round((used / total) * 100);
  return `${formatSize(used)} / ${formatSize(total)} (${pct}%)`;
}

/** Clamps a used/total ratio to a 0-100 percentage. */
export function usagePercent(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
