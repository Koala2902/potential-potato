/** Shared formatting helpers for the Analytics page. */

export function formatDurationSeconds(seconds: number | null | undefined): string {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const minutes = Math.floor(s / 60);
    const remSec = s % 60;
    if (minutes < 60) {
        return remSec === 0 ? `${minutes}m` : `${minutes}m ${remSec}s`;
    }
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    if (hours < 24) {
        return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
    }
    const days = Math.floor(hours / 24);
    const remHrs = hours % 24;
    return remHrs === 0 ? `${days}d` : `${days}d ${remHrs}h`;
}

export function formatPercent(pct: number | null | undefined): string {
    if (pct == null || !Number.isFinite(pct)) return '—';
    return `${pct.toFixed(1)}%`;
}

export function formatHours(hours: number | null | undefined): string {
    if (hours == null || !Number.isFinite(hours)) return '—';
    if (hours < 1) {
        const m = Math.round(hours * 60);
        return `${m}m`;
    }
    return `${hours.toFixed(1)}h`;
}
