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
