import { isUndefinedTableError } from './pg-errors.js';
import {
    withImpositionFileMappingClient,
    withPlannerAppThenLogsOnEmpty,
} from './planner-client.js';
import {
    fileIdPatternLoose,
    fileIdPatternStrict,
    isNumericVersionSuffix,
    labexJobIdSegmentPattern,
    parseJobIdVersionTagScan,
} from './scan-job-version.js';
import { getPrintOsPool } from './print-os-pool.js';

export interface ProductionQueueItem {
    runlist_id: string;
    imposition_count: number;
    impositions: ImpositionItem[];
}

export interface ImpositionItem {
    imposition_id: string;
    simplified_name: string;
    sheet_width?: number;
}

export interface ImpositionDetails {
    imposition_id: string;
    file_id: string;
    [key: string]: any;
}

function normalizeLooseId(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalJobIdForMatching(jobId: string): string {
    const parts = jobId.trim().split('_').filter(Boolean);
    if (parts.length >= 3 && parts.every((p) => /^\d+$/.test(p))) {
        return `${parts[0]}_${parts[1]}`;
    }
    return jobId.trim();
}

function getOrderPrefixFromJobId(jobId: string): string | null {
    const m = jobId.trim().match(/(\d{4})/);
    return m ? m[1] : null;
}

function parseLabexFileIdForQty(fileId: string): { jobId: string; versionTag: string } | null {
    if (!fileId.toLowerCase().includes('labex')) return null;
    const m = fileId.match(/^FILE_(\d+)_Labex_(.+)$/);
    if (!m) {
        const simple = fileId.match(/^Labex_(\d+_\d+)(?:_(\d+))?(?:_|$)/i);
        if (simple) {
            return { jobId: simple[1]!, versionTag: simple[2] || '1' };
        }
        return null;
    }

    const versionTag = m[1]!;
    const afterLabex = m[2]!;
    const parts = afterLabex.split('_');
    const numericLeading: string[] = [];
    for (const p of parts) {
        if (/^\d+$/.test(p)) numericLeading.push(p);
        else break;
    }
    if (numericLeading.length >= 2) {
        return { jobId: `${numericLeading[0]}_${numericLeading[1]}`, versionTag };
    }
    if (numericLeading.length === 1) {
        return { jobId: numericLeading[0]!, versionTag };
    }
    return null;
}

// Get production queue grouped by runlist_id
export async function getProductionQueue(): Promise<ProductionQueueItem[]> {
    try {
        return await withPlannerAppThenLogsOnEmpty(async (client) => {
            const result = await client.query(`
            SELECT 
                runlist_id,
                COUNT(DISTINCT imposition_id) as imposition_count,
                ARRAY_AGG(DISTINCT imposition_id ORDER BY imposition_id) as imposition_ids
            FROM production_planner_paths
            WHERE runlist_id IS NOT NULL
            GROUP BY runlist_id
            ORDER BY runlist_id
        `);

            const queue: ProductionQueueItem[] = result.rows.map((row) => {
                const impositions: ImpositionItem[] = (row.imposition_ids || []).map((id: string) => {
                    const parts = id.split('_');

                    const sizeMatch = parts.find((p) => /^\d+x\d+/.test(p));
                    const shapeMatch = parts.find((p) =>
                        ['circle', 'rectangle', 'square'].includes(p.toLowerCase())
                    );
                    const configIndex = parts.findIndex((p) => p.toLowerCase() === 'config');
                    const configNumber =
                        configIndex >= 0 && configIndex < parts.length - 1 ? parts[configIndex + 1] : null;

                    let simplified = id;
                    if (sizeMatch && shapeMatch && configNumber) {
                        const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                        simplified = `${sizeMatch} ${shapeCapitalized} Config ${configNumber}`;
                    } else if (sizeMatch && configNumber) {
                        simplified = `${sizeMatch} Config ${configNumber}`;
                    } else if (sizeMatch && shapeMatch) {
                        const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                        simplified = `${sizeMatch} ${shapeCapitalized}`;
                    } else if (parts.length > 0) {
                        const lastParts = parts.slice(-3);
                        simplified = lastParts
                            .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
                            .join(' ');
                    }

                    return {
                        imposition_id: id,
                        simplified_name: simplified,
                    };
                });

                return {
                    runlist_id: row.runlist_id,
                    imposition_count: parseInt(row.imposition_count) || impositions.length,
                    impositions,
                };
            });

            return queue;
        }, (queue) => queue.length === 0);
    } catch (e) {
        if (isUndefinedTableError(e)) return [];
        throw e;
    }
}

// Get imposition details including all file_ids from imposition_file_mapping
export async function getImpositionDetails(impositionId: string): Promise<ImpositionDetails | null> {
    return withImpositionFileMappingClient(async (client) => {
        const configResult = await client.query(
            `
            SELECT DISTINCT
                ic.explanation,
                ic.pdf_quantity,
                ic.exact,
                ic.layout_across,
                ic.sheet_width,
                ic.sheet_height
            FROM imposition_configurations ic
            WHERE ic.imposition_id = $1
            LIMIT 1
        `,
            [impositionId]
        );

        const fileResult = await client.query(
            `
            SELECT file_id
            FROM imposition_file_mapping
            WHERE imposition_id = $1
            ORDER BY sequence_order NULLS LAST, file_id
        `,
            [impositionId]
        );
        const fileIds = fileResult.rows.map((row) => row.file_id);

        const parsedPairs = fileIds
            .map((id: string) => ({ fileId: id, parsed: parseLabexFileIdForQty(id) }))
            .filter((x): x is { fileId: string; parsed: { jobId: string; versionTag: string } } => x.parsed !== null);

        const uniquePairs: Array<{ jobId: string; versionTag: string }> = [];
        const seen = new Set<string>();
        for (const row of parsedPairs) {
            const key = `${row.parsed.jobId}|${row.parsed.versionTag}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniquePairs.push(row.parsed);
        }

        const qtyByPair = new Map<string, number | null>();
        if (uniquePairs.length > 0) {
            const valuesSql = uniquePairs
                .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
                .join(', ');
            const valuesParams = uniquePairs.flatMap((x) => [x.jobId, x.versionTag]);
            try {
                const qtyResult = await client.query(
                    `
                    SELECT job_id, version_tag, version_quantity
                    FROM single_page_files
                    WHERE (job_id, version_tag) IN (${valuesSql})
                `,
                    valuesParams
                );
                for (const r of qtyResult.rows) {
                    const raw = Number(r.version_quantity);
                    const valid = Number.isFinite(raw) && raw > 0 ? raw : null;
                    qtyByPair.set(`${r.job_id}|${r.version_tag}`, valid);
                }
            } catch (e) {
                if (!isUndefinedTableError(e)) {
                    console.warn('[getImpositionDetails] qty lookup failed in single_page_files:', e);
                }
            }
        }

        let notesExplanation: string | null = null;
        if (uniquePairs.length > 0) {
            const normalizedJobIds = Array.from(
                new Set(
                    uniquePairs.flatMap((x) => {
                        const canonical = canonicalJobIdForMatching(x.jobId);
                        const compositeWithVersion = `${x.jobId}_${x.versionTag}`;
                        const canonicalWithVersion = `${canonical}_${x.versionTag}`;
                        const labexJobId = `Labex_${x.jobId}`;
                        const labexCanonicalJobId = `Labex_${canonical}`;
                        return [
                            normalizeLooseId(x.jobId),
                            normalizeLooseId(canonical),
                            normalizeLooseId(compositeWithVersion),
                            normalizeLooseId(canonicalWithVersion),
                            normalizeLooseId(labexJobId),
                            normalizeLooseId(labexCanonicalJobId),
                        ];
                    })
                )
            ).filter(Boolean);

            if (normalizedJobIds.length > 0) {
                const notesClient = await getPrintOsPool().connect();
                try {
                    const notesResult = await notesClient.query(
                        `
                        SELECT
                            j.job_id,
                            j.notes
                        FROM public.jobs j
                        WHERE j.notes IS NOT NULL
                          AND NULLIF(BTRIM(j.notes), '') IS NOT NULL
                          AND regexp_replace(lower(j.job_id), '[^a-z0-9]+', '', 'g') = ANY($1::text[])
                        ORDER BY j.job_id
                    `,
                        [normalizedJobIds]
                    );

                    const orderToNotes = new Map<string, string>();
                    for (const row of notesResult.rows) {
                        const jobId = String(row.job_id ?? '').trim();
                        const note = String(row.notes ?? '').trim();
                        if (!jobId || !note) continue;
                        const orderPrefix = getOrderPrefixFromJobId(jobId);
                        if (!orderPrefix || orderToNotes.has(orderPrefix)) continue;
                        orderToNotes.set(orderPrefix, note);
                    }

                    if (orderToNotes.size > 0) {
                        notesExplanation = Array.from(orderToNotes.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([orderPrefix, note]) => `${orderPrefix}: ${note}`)
                            .join('\n');
                    }
                } catch (e) {
                    if (!isUndefinedTableError(e)) {
                        console.warn('[getImpositionDetails] notes lookup failed in public.jobs:', e);
                    }
                } finally {
                    notesClient.release();
                }
            }
        }

        const existingExplanation = configResult.rows[0]?.explanation;

        return {
            imposition_id: impositionId,
            file_ids: fileIds,
            ...(configResult.rows[0] ?? {}),
            explanation:
                notesExplanation ??
                (typeof existingExplanation === 'string' ? existingExplanation : null),
        };
    });
}

// Get all file_ids for an imposition_id
export async function getFileIds(impositionId: string): Promise<string[]> {
    return withImpositionFileMappingClient(async (client) => {
        const result = await client.query(
            `
            SELECT file_id
            FROM imposition_file_mapping
            WHERE imposition_id = $1
            ORDER BY sequence_order NULLS LAST, file_id
        `,
            [impositionId]
        );

        const fileIds = result.rows.map((row) => row.file_id as string);

        const parsedPairs = fileIds
            .map((id) => ({ fileId: id, parsed: parseLabexFileIdForQty(id) }))
            .filter((x): x is { fileId: string; parsed: { jobId: string; versionTag: string } } => x.parsed !== null);

        const uniquePairs: Array<{ jobId: string; versionTag: string }> = [];
        const seen = new Set<string>();
        for (const row of parsedPairs) {
            const key = `${row.parsed.jobId}|${row.parsed.versionTag}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniquePairs.push(row.parsed);
        }

        const qtyByPair = new Map<string, number | null>();
        if (uniquePairs.length > 0) {
            const valuesSql = uniquePairs
                .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
                .join(', ');
            const valuesParams = uniquePairs.flatMap((x) => [x.jobId, x.versionTag]);
            try {
                const qtyResult = await client.query(
                    `
                    SELECT job_id, version_tag, version_quantity
                    FROM single_page_files
                    WHERE (job_id, version_tag) IN (${valuesSql})
                `,
                    valuesParams
                );
                for (const r of qtyResult.rows) {
                    const raw = Number(r.version_quantity);
                    const valid = Number.isFinite(raw) && raw > 0 ? raw : null;
                    qtyByPair.set(`${r.job_id}|${r.version_tag}`, valid);
                }
            } catch (e) {
                if (!isUndefinedTableError(e)) {
                    console.warn('[getFileIds] qty lookup failed in single_page_files:', e);
                }
            }
        }

        const jobMetaByNormalizedId = new Map<string, { cores: string; rollDirection: string }>();
        if (uniquePairs.length > 0) {
            const normalizedJobIds = Array.from(
                new Set(
                    uniquePairs.flatMap((x) => {
                        const canonical = canonicalJobIdForMatching(x.jobId);
                        const compositeWithVersion = `${x.jobId}_${x.versionTag}`;
                        const canonicalWithVersion = `${canonical}_${x.versionTag}`;
                        const labexJobId = `Labex_${x.jobId}`;
                        const labexCanonicalJobId = `Labex_${canonical}`;
                        return [
                            normalizeLooseId(x.jobId),
                            normalizeLooseId(canonical),
                            normalizeLooseId(compositeWithVersion),
                            normalizeLooseId(canonicalWithVersion),
                            normalizeLooseId(labexJobId),
                            normalizeLooseId(labexCanonicalJobId),
                        ];
                    })
                )
            ).filter(Boolean);

            if (normalizedJobIds.length > 0) {
                const jobsClient = await getPrintOsPool().connect();
                try {
                    const jobsResult = await jobsClient.query(
                        `
                        SELECT
                            j.job_id,
                            j.cores,
                            j.roll_direction
                        FROM public.jobs j
                        WHERE regexp_replace(lower(j.job_id), '[^a-z0-9]+', '', 'g') = ANY($1::text[])
                    `,
                        [normalizedJobIds]
                    );

                    for (const row of jobsResult.rows) {
                        const rawJobId = String(row.job_id ?? '').trim();
                        if (!rawJobId) continue;
                        const normalized = normalizeLooseId(rawJobId);
                        const rawWithoutLabexPrefix = rawJobId.replace(/^Labex_/i, '').trim();
                        const normalizedWithoutLabexPrefix = normalizeLooseId(rawWithoutLabexPrefix);
                        const cores = String(row.cores ?? '').trim();
                        const rollDirection = String(row.roll_direction ?? '').trim();
                        const meta = { cores, rollDirection };
                        if (!jobMetaByNormalizedId.has(normalized)) {
                            jobMetaByNormalizedId.set(normalized, meta);
                        }
                        if (normalizedWithoutLabexPrefix && !jobMetaByNormalizedId.has(normalizedWithoutLabexPrefix)) {
                            jobMetaByNormalizedId.set(normalizedWithoutLabexPrefix, meta);
                        }
                    }
                } catch (e) {
                    if (!isUndefinedTableError(e)) {
                        console.warn('[getFileIds] jobs roll/core lookup failed in public.jobs:', e);
                    }
                } finally {
                    jobsClient.release();
                }
            }
        }

        return fileIds.map((fileId) => {
            const parsed = parseLabexFileIdForQty(fileId);
            if (!parsed) {
                return `${fileId} · Qty: `;
            }
            const qty = qtyByPair.get(`${parsed.jobId}|${parsed.versionTag}`) ?? null;
            const normalized = normalizeLooseId(parsed.jobId);
            const canonicalNormalized = normalizeLooseId(canonicalJobIdForMatching(parsed.jobId));
            const meta =
                jobMetaByNormalizedId.get(normalized) ||
                jobMetaByNormalizedId.get(canonicalNormalized);
            const qtyText = qty == null ? '' : String(qty);
            const coresText = meta?.cores ?? '';
            const rollDirectionText = meta?.rollDirection ?? '';
            const suffix = [qtyText, coresText, rollDirectionText].filter((x) => x.length > 0).join('_');
            return `${parsed.jobId}_${parsed.versionTag} · Qty: ${suffix}`;
        });
    });
}

// Resolve runlist_id: runlist match, exact file_id, Labex short form, partial runlist, job_id_version_tag
export async function findRunlistByScan(scanInput: string): Promise<string | null> {
    return withImpositionFileMappingClient(async (client) => {
        let exactMatch = await client.query(
            `SELECT DISTINCT runlist_id 
             FROM production_planner_paths 
             WHERE runlist_id = $1 
             LIMIT 1`,
            [scanInput]
        );

        if (exactMatch.rows.length === 1) {
            return exactMatch.rows[0].runlist_id;
        }

        // Full file_id barcode
        const byExactFileId = await client.query(
            `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id = $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 2
            `,
            [scanInput.trim()]
        );
        if (byExactFileId.rows.length === 1) {
            return byExactFileId.rows[0].runlist_id;
        }
        if (byExactFileId.rows.length > 1) {
            console.warn(
                `[findRunlistByScan] file_id matches multiple runlists (${byExactFileId.rows.length}), returning null`
            );
            return null;
        }

        // Short QR (e.g. 5475_7066) vs DB file_id containing Labex_5475_7066
        const short = scanInput.trim();
        if (short.includes('_')) {
            const byLabexSegment = await client.query(
                `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id LIKE $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 2
            `,
                [`%Labex_${short}%`]
            );
            if (byLabexSegment.rows.length === 1) {
                return byLabexSegment.rows[0].runlist_id;
            }
            if (byLabexSegment.rows.length > 1) {
                console.warn(
                    `[findRunlistByScan] Labex short form matches multiple runlists (${byLabexSegment.rows.length}), returning null`
                );
                return null;
            }
        }

        let partialMatch = await client.query(
            `SELECT DISTINCT runlist_id 
             FROM production_planner_paths 
             WHERE (runlist_id LIKE $1 OR runlist_id LIKE $2)
             AND runlist_id IS NOT NULL
             ORDER BY runlist_id`,
            [`${scanInput}%`, `%${scanInput}%`]
        );

        if (partialMatch.rows.length === 1) {
            return partialMatch.rows[0].runlist_id;
        } else if (partialMatch.rows.length > 1) {
            // Ambiguous partial runlist match
            return null;
        }

        const jv = parseJobIdVersionTagScan(scanInput);
        if (jv) {
            const strictPat = fileIdPatternStrict(jv.jobId, jv.versionTag);
            const strict = await client.query(
                `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id LIKE $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 1
        `,
                [strictPat]
            );

            if (strict.rows.length > 0) {
                return strict.rows[0].runlist_id;
            }

            // QR may include _1 while DB FILE_* version may not match; retry any FILE_*_Labex_<jobId>_%
            if (isNumericVersionSuffix(jv.versionTag)) {
                const loosePat = fileIdPatternLoose(jv.jobId);
                const loose = await client.query(
                    `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id LIKE $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 3
        `,
                    [loosePat]
                );
                if (loose.rows.length === 1) {
                    return loose.rows[0].runlist_id;
                }
                if (loose.rows.length > 1) {
                    console.warn(
                        `[findRunlistByScan] loose job_id match for ${jv.jobId} returned multiple runlists; returning null`
                    );
                }
            }

            // Some file_ids omit FILE_* and only contain Labex_<jobId>…
            const labexPat = labexJobIdSegmentPattern(jv.jobId);
            const labex = await client.query(
                `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id LIKE $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 3
        `,
                [labexPat]
            );
            if (labex.rows.length === 1) {
                return labex.rows[0].runlist_id;
            }
            if (labex.rows.length > 1) {
                console.warn(
                    `[findRunlistByScan] Labex_${jv.jobId} segment matched multiple runlists; returning null`
                );
            }
        }

        return null;
    });
}

// Get production queue filtered by runlist_id
export async function getProductionQueueByRunlist(runlistId: string): Promise<ProductionQueueItem[]> {
    return withPlannerAppThenLogsOnEmpty(async (client) => {
        const result = await client.query(
            `
            SELECT DISTINCT
                ppp.runlist_id,
                ppp.imposition_id,
                COALESCE(ic.sheet_width, 0) as sheet_width
            FROM production_planner_paths ppp
            LEFT JOIN imposition_configurations ic ON ic.imposition_id = ppp.imposition_id
            WHERE ppp.runlist_id = $1
            ORDER BY COALESCE(ic.sheet_width, 0) ASC, ppp.imposition_id
        `,
            [runlistId]
        );

        if (result.rows.length === 0) {
            return [];
        }

        const impositions: ImpositionItem[] = result.rows.map((row) => {
            const id = row.imposition_id;
            const parts = id.split('_');
            const sizeMatch = parts.find((p: string) => /^\d+x\d+/.test(p));
            const shapeMatch = parts.find((p: string) =>
                ['circle', 'rectangle', 'square'].includes(p.toLowerCase())
            );
            const configIndex = parts.findIndex((p: string) => p.toLowerCase() === 'config');
            const configNumber =
                configIndex >= 0 && configIndex < parts.length - 1 ? parts[configIndex + 1] : null;

            let simplified = id;
            if (sizeMatch && shapeMatch && configNumber) {
                const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                simplified = `${sizeMatch} ${shapeCapitalized} Config ${configNumber}`;
            } else if (sizeMatch && configNumber) {
                simplified = `${sizeMatch} Config ${configNumber}`;
            } else if (sizeMatch && shapeMatch) {
                const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                simplified = `${sizeMatch} ${shapeCapitalized}`;
            } else if (parts.length > 0) {
                const lastParts = parts.slice(-3);
                simplified = lastParts
                    .map((p: string, i: number) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
                    .join(' ');
            }

            return {
                imposition_id: id,
                simplified_name: simplified,
                sheet_width: parseFloat(row.sheet_width) || 0,
            };
        });

        return [
            {
                runlist_id: runlistId,
                imposition_count: impositions.length,
                impositions,
            },
        ];
    }, (q) => q.length === 0);
}

export async function getDistinctFileIdsForRunlist(runlistId: string): Promise<{ file_id: string }[]> {
    return withImpositionFileMappingClient(async (client) => {
        const fileIdsResult = await client.query(
            `
                        SELECT DISTINCT ifm.file_id
                        FROM imposition_file_mapping ifm
                        INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                        WHERE ppp.runlist_id = $1
                        ORDER BY ifm.file_id
                    `,
            [runlistId]
        );
        return fileIdsResult.rows as { file_id: string }[];
    });
}

export async function findRunlistIdsMatchingScanFragment(scan: string): Promise<string[]> {
    return withPlannerAppThenLogsOnEmpty(async (client) => {
        const multipleMatch = await client.query(
            `SELECT DISTINCT runlist_id 
                     FROM production_planner_paths 
                     WHERE (runlist_id LIKE $1 OR runlist_id LIKE $2)
                     AND runlist_id IS NOT NULL`,
            [`${scan}%`, `%${scan}%`]
        );
        return multipleMatch.rows.map((r) => r.runlist_id as string);
    }, (ids) => ids.length === 0);
}

/** Resolve imposition when the scan string is an exact file_id (full barcode). */
export async function findImpositionIdByExactFileId(fileId: string): Promise<string | null> {
    return withImpositionFileMappingClient(async (client) => {
        const r = await client.query(
            `SELECT imposition_id FROM imposition_file_mapping WHERE file_id = $1 LIMIT 1`,
            [fileId.trim()]
        );
        return r.rows.length > 0 ? (r.rows[0].imposition_id as string) : null;
    });
}

/** Short QR like "5475_7066" while DB file_id contains "Labex_5475_7066". */
export async function findImpositionIdByLabexShortScan(scan: string): Promise<string | null> {
    const s = scan.trim();
    if (!s.includes('_')) {
        return null;
    }
    return withImpositionFileMappingClient(async (client) => {
        const r = await client.query(
            `SELECT DISTINCT imposition_id FROM imposition_file_mapping WHERE file_id LIKE $1 LIMIT 2`,
            [`%Labex_${s}%`]
        );
        if (r.rows.length === 1) {
            return r.rows[0].imposition_id as string;
        }
        if (r.rows.length > 1) {
            console.warn(
                `[findImpositionIdByLabexShortScan] multiple impositions for Labex_${s}, ambiguous`
            );
        }
        return null;
    });
}

export async function findImpositionIdByFilePattern(filePattern: string): Promise<string | null> {
    return withImpositionFileMappingClient(async (client) => {
        const impositionResult = await client.query(
            `
                        SELECT DISTINCT imposition_id
                        FROM imposition_file_mapping
                        WHERE file_id LIKE $1
                        LIMIT 1
                    `,
            [filePattern]
        );
        return impositionResult.rows.length > 0
            ? (impositionResult.rows[0].imposition_id as string)
            : null;
    });
}

const IMPOSITION_IN_RUNLIST = `
    FROM imposition_file_mapping ifm
    INNER JOIN production_planner_paths ppp ON ppp.imposition_id = ifm.imposition_id
    WHERE ppp.runlist_id = $1`;

/**
 * Pick imposition for PDF/details preview after runlist is known.
 * Scoped to this runlist only (same patterns as findRunlistByScan: exact, Labex short, FILE_*, loose, Labex segment).
 */
export async function findImpositionIdForScanInRunlist(
    scan: string,
    runlistId: string
): Promise<string | null> {
    return withImpositionFileMappingClient(async (client) => {
        const trimmed = scan.trim();

        const singleDistinct = async (sql: string, params: unknown[]): Promise<string | null> => {
            const r = await client.query(sql, params);
            if (r.rows.length === 1) {
                return r.rows[0].imposition_id as string;
            }
            return null;
        };

        let found = await singleDistinct(
            `SELECT DISTINCT ifm.imposition_id ${IMPOSITION_IN_RUNLIST} AND ifm.file_id = $2 LIMIT 2`,
            [runlistId, trimmed]
        );
        if (found) return found;

        if (trimmed.includes('_')) {
            found = await singleDistinct(
                `SELECT DISTINCT ifm.imposition_id ${IMPOSITION_IN_RUNLIST} AND ifm.file_id LIKE $2 LIMIT 2`,
                [runlistId, `%Labex_${trimmed}%`]
            );
            if (found) return found;
        }

        const jv = parseJobIdVersionTagScan(trimmed);
        if (jv) {
            const patterns = [fileIdPatternStrict(jv.jobId, jv.versionTag)];
            if (isNumericVersionSuffix(jv.versionTag)) {
                patterns.push(fileIdPatternLoose(jv.jobId));
            }
            patterns.push(labexJobIdSegmentPattern(jv.jobId));

            for (const pat of patterns) {
                found = await singleDistinct(
                    `SELECT DISTINCT ifm.imposition_id ${IMPOSITION_IN_RUNLIST} AND ifm.file_id LIKE $2 LIMIT 2`,
                    [runlistId, pat]
                );
                if (found) return found;
            }
        }

        return null;
    });
}

export async function findSimilarFileIdsForDebug(
    version: string,
    jobId: string
): Promise<{ file_id: string; imposition_id: string }[]> {
    return withImpositionFileMappingClient(async (client) => {
        const debugResult = await client.query(
            `
                            SELECT DISTINCT file_id, imposition_id
                            FROM imposition_file_mapping
                            WHERE file_id LIKE $1 OR file_id LIKE $2
                            LIMIT 5
                        `,
            [`FILE_${version}_Labex_%${jobId}%`, `FILE_%_Labex_${jobId}_%`]
        );
        return debugResult.rows as { file_id: string; imposition_id: string }[];
    });
}
