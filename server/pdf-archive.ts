import fs from 'fs';
import path from 'path';

/**
 * Mounted folder for imposition PDFs (cannot use smb:// — mount the share in Finder, then use the /Volumes/... path).
 * Example Synology layout: .../RDevArchive/2026/<imposition_id>.pdf
 */
export const PDF_ARCHIVE_PATH =
    process.env.PDF_ARCHIVE_PATH?.trim() ||
    '/Volumes/Daily Print Jobs/_NEXT HotFolder/RDevArchive';

const PATH_CACHE_TTL_MS = 5 * 60 * 1000;

type PathCacheEntry = {
    path: string;
    mtimeMs: number;
    size: number;
    cachedAt: number;
};

const pathCache = new Map<string, PathCacheEntry>();

/** Comma-separated year folder names to try under PDF_ARCHIVE_PATH (default: current year and two prior). */
export function pdfYearSubfoldersToTry(): string[] {
    if (process.env.PDF_ARCHIVE_TRY_YEAR_SUBFOLDERS === 'false') {
        return [];
    }
    const custom = process.env.PDF_ARCHIVE_YEAR_FOLDERS?.trim();
    if (custom) {
        return custom.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const y = new Date().getFullYear();
    return [String(y), String(y - 1), String(y - 2)];
}

function probePdfPath(impositionId: string): string | null {
    const name = `${impositionId}.pdf`;
    const direct = path.join(PDF_ARCHIVE_PATH, name);
    if (fs.existsSync(direct)) {
        return direct;
    }
    for (const y of pdfYearSubfoldersToTry()) {
        const nested = path.join(PDF_ARCHIVE_PATH, y, name);
        if (fs.existsSync(nested)) {
            return nested;
        }
    }
    return null;
}

/** First path that exists: flat `<archive>/<id>.pdf`, then `<archive>/<year>/<id>.pdf`. */
export function resolvePdfPathForImposition(impositionId: string): string | null {
    const resolved = resolvePdfWithStats(impositionId);
    return resolved?.path ?? null;
}

export function resolvePdfWithStats(
    impositionId: string
): { path: string; stats: fs.Stats } | null {
    const now = Date.now();
    const cached = pathCache.get(impositionId);
    if (cached && now - cached.cachedAt < PATH_CACHE_TTL_MS) {
        if (fs.existsSync(cached.path)) {
            const stats = fs.statSync(cached.path);
            if (stats.mtimeMs === cached.mtimeMs && stats.size === cached.size) {
                return { path: cached.path, stats };
            }
        }
        pathCache.delete(impositionId);
    }

    const pdfPath = probePdfPath(impositionId);
    if (!pdfPath) {
        pathCache.delete(impositionId);
        return null;
    }

    const stats = fs.statSync(pdfPath);
    pathCache.set(impositionId, {
        path: pdfPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        cachedAt: now,
    });
    return { path: pdfPath, stats };
}

export function pdfEtag(stats: fs.Stats): string {
    return `"${stats.mtimeMs}-${stats.size}"`;
}

/** Logs a warning when no PDF exists under the archive (flat or year subfolder). */
export function warnIfPdfMissing(impositionId: string): void {
    if (!resolvePdfPathForImposition(impositionId)) {
        console.warn(`[pdf] Not found under ${PDF_ARCHIVE_PATH}: ${impositionId}.pdf`);
    }
}

export function logPdfArchiveStartup(): void {
    console.log(
        `PDF archive: ${PDF_ARCHIVE_PATH} (flat + year subfolders: ${pdfYearSubfoldersToTry().join(', ') || 'off'})`
    );
    if (!fs.existsSync(PDF_ARCHIVE_PATH)) {
        console.warn(
            `[pdf] Path does not exist or is not mounted. Mount the SMB share in Finder, set PDF_ARCHIVE_PATH to the RDevArchive folder (not smb://).`
        );
    }
}
