/**
 * job_id_version_tag scans (e.g. 5510_7110_1): last segment is version; rest is job id.
 * Some single-version jobs store FILE_* without a matching version segment in DB; QR may still include _1.
 */

/** Parse `5510_7110_1` → jobId `5510_7110`, version `1`. Requires ≥3 underscore-separated parts. */
export function parseJobIdVersionTagScan(codeText: string): { jobId: string; versionTag: string } | null {
    const parts = codeText.trim().split("_");
    if (parts.length < 3) return null;
    const versionTag = parts[parts.length - 1]!;
    const jobId = parts.slice(0, -1).join("_");
    return { jobId, versionTag };
}

/**
 * Labex device barcodes: `Labex_4941_6330_85x200_...` → jobId `4941_6330`, versionTag `1` (same keys as
 * `FILE_*_Labex_4941_6330_*` / `job_operation_duration`, not split as job 4941 + version 6330).
 * Leading numeric segments after `Labex_` form the composite job id; version is the FILE sheet number (default `1`).
 * Non-Labex codes fall back to {@link parseJobIdVersionTagScan} (runlist `job_job_job_1` style).
 */
/**
 * Labex barcodes that encode **multiple** composite jobs separated by `-`, e.g.
 * `Labex_5528_7153-5528_7149-5528_7150-5528_7151-5528_7152-5528_7154_40x40_Square_...`
 * Each hyphen-separated segment must start with `digits_digits` (same composite form as FILE_* / IFM).
 * Returns null if there is no hyphen or fewer than two distinct jobs (use {@link parseJobIdVersionFromScanCode}).
 */
export function parseMultiJobLabexBarcode(baseCodeText: string): string[] | null {
    const t = baseCodeText.trim();
    if (!t.toLowerCase().startsWith('labex_')) return null;
    const rest = t.slice(6);
    if (!rest.includes('-')) return null;
    const jobIds: string[] = [];
    for (const seg of rest.split('-')) {
        const m = seg.trim().match(/^(\d+_\d+)/);
        if (m) jobIds.push(m[1]!);
    }
    const unique = [...new Set(jobIds)];
    return unique.length >= 2 ? unique : null;
}

export function parseJobIdVersionFromScanCode(baseCodeText: string): {
    jobId: string;
    versionTag: string;
} | null {
    const t = baseCodeText.trim();
    if (t.toLowerCase().startsWith("labex_")) {
        const rest = t.slice(6);
        const parts = rest.split("_").filter(Boolean);
        const numericLeading: string[] = [];
        for (const p of parts) {
            if (/^\d+$/.test(p)) numericLeading.push(p);
            else break;
        }
        if (numericLeading.length >= 2) {
            return { jobId: `${numericLeading[0]}_${numericLeading[1]}`, versionTag: "1" };
        }
        if (numericLeading.length === 1) {
            return { jobId: numericLeading[0]!, versionTag: "1" };
        }
        return null;
    }
    return parseJobIdVersionTagScan(t);
}

/**
 * Display key for Production enrich: Labex → composite job id only (`4941_6330`); runlist-style codes → `jobId` from parser.
 */
export function scanCodeToJobDisplayId(baseCodeText: string): string | null {
    const parsed = parseJobIdVersionFromScanCode(baseCodeText);
    if (!parsed) return null;
    const t = baseCodeText.trim();
    if (t.toLowerCase().startsWith("labex_")) {
        return parsed.jobId;
    }
    return parsed.jobId;
}

/**
 * Legacy `job_operation_duration.job_id` (and similar) may store an extra numeric segment from old
 * FILE_* Labex parsing (e.g. `5516_7121_1`). API / UI should show the composite id `5516_7121` only.
 * Collapses when all segments are digits, at least three segments, and the first two look like Labex composites (length ≥ 3).
 */
export function canonicalCompositeJobIdForDisplay(jobId: string): string {
    const parts = jobId.trim().split('_').filter(Boolean);
    if (parts.length < 3) return jobId;
    if (!parts.every((p) => /^\d+$/.test(p))) return jobId;
    if (parts[0]!.length >= 3 && parts[1]!.length >= 3) {
        return `${parts[0]}_${parts[1]}`;
    }
    return jobId;
}

/** True when trailing segment looks like a numeric version (retry loose FILE_% match if strict fails). */
export function isNumericVersionSuffix(versionTag: string): boolean {
    return /^\d+$/.test(versionTag);
}

export function fileIdPatternStrict(jobId: string, versionTag: string): string {
    return `FILE_${versionTag}_Labex_${jobId}_%`;
}

/** Any FILE_<v>_Labex_<jobId>_ — use when strict version match finds nothing. */
export function fileIdPatternLoose(jobId: string): string {
    return `FILE_%_Labex_${jobId}_%`;
}

/**
 * imposition_file_mapping.file_id may not always use FILE_*_Labex_*; some rows only contain
 * Labex_<jobId> (e.g. Labex_5510_7110_…).
 */
export function labexJobIdSegmentPattern(jobId: string): string {
    return `%Labex_${jobId}%`;
}
