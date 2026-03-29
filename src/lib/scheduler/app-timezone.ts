/** IANA zone for job calendar bucketing (matches `VITE_TZ` or browser default). */
export function getAppTimeZone(): string {
  return import.meta.env.VITE_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
