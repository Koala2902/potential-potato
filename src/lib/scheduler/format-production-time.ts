/** Compact label for calendar pills, e.g. `1h 2m`, `45m`, `—` if unknown. */
export function formatProductionTimeShort(
  minutes: number | null | undefined
): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
