import { randomBytes } from "node:crypto";
import { Router } from "express";
import type pg from "pg";

import { getPrintOsDatabaseUrl } from "./db/database-config.js";
import { getPrintOsPool } from "./db/print-os-pool.js";
import { isUndefinedColumnError, isUndefinedTableError } from "./db/pg-errors.js";

/**
 * Material / stock catalog on jobmanager `public` (allowlisted tables).
 * GET routes are read-only; POST `/materials` creates a row; PATCH `/materials/:id` updates catalog + qty; DELETE removes the row and allowlisted child rows.
 *
 * Allowlist: materials, material_groups, material_supplier_pricing, material_conversions,
 * material_print_profiles, material_stock_movements. No join to `scheduler.Job`.
 */
const ALLOWED_STOCK_TABLES = [
    "materials",
    "material_groups",
    "material_group_memberships",
    "material_supplier_pricing",
    "material_conversions",
    "material_print_profiles",
    "material_stock_movements",
] as const;

const MATERIAL_FROM = `FROM public.materials m
             LEFT JOIN LATERAL (
               SELECT COALESCE(
                 json_agg(
                   json_build_object(
                     'group_id', g2.group_id,
                     'group_name', g2.group_name,
                     'group_color', g2.group_color
                   )
                   ORDER BY mgm.sort_order ASC, g2.group_name ASC
                 ),
                 '[]'::json
               ) AS substrate_groups
               FROM public.material_group_memberships mgm
               JOIN public.material_groups g2 ON g2.group_id = mgm.group_id
               WHERE mgm.material_id = m.material_id
             ) grp ON true
             LEFT JOIN public.material_groups g ON g.group_id = m.substrate_group`;

const MATERIAL_SELECT_LIST = `SELECT
               m.material_id,
               m.material_code,
               m.material_name,
               m.substrate_type,
               m.adhesive_type,
               m.handling,
               m.weight_gsm,
               m.width_mm,
               m.length_mm,
               m.coating,
               m.grain_direction,
               m.glossy_level,
               m.conductive,
               m.white_material,
               m.pricing_unit,
               m.substrate_group,
               m.stock,
               m.reorder_level,
               m.lead_time_days,
               m.cost_aud,
               m.aliases,
               m.is_active,
               m.internal_barcode,
               m.vendor_barcode,
               m.alternate_barcode,
               m.company,
               m.location,
               COALESCE(grp.substrate_groups, '[]'::json) AS substrate_groups,
               g.group_name AS substrate_group_name,
               g.group_color AS substrate_group_color,
               CASE
                 WHEN m.stock IS NOT NULL AND m.reorder_level IS NOT NULL AND m.stock <= m.reorder_level
                 THEN true ELSE false
               END AS low_stock
             ${MATERIAL_FROM}`;

function parseStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
        const s = String(item ?? "").trim();
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

function parseGroupIdsQuery(req: { query: Record<string, unknown> }): string[] {
    const ids: string[] = [];
    const multi = req.query.groupIds;
    if (typeof multi === "string" && multi.trim()) {
        for (const part of multi.split(",")) {
            const s = part.trim();
            if (s && !ids.includes(s)) ids.push(s);
        }
    } else if (Array.isArray(multi)) {
        for (const item of multi) {
            const s = String(item ?? "").trim();
            if (s && !ids.includes(s)) ids.push(s);
        }
    }
    const legacy = req.query.groupId;
    if (typeof legacy === "string" && legacy.trim()) {
        const s = legacy.trim();
        if (!ids.includes(s)) ids.push(s);
    }
    return ids;
}

function parseSubstrateGroupIdsFromBody(body: PatchBody): string[] | undefined {
    if ("substrate_groups" in body) return parseStringArray(body.substrate_groups);
    if ("substrate_group" in body) {
        const one = optionalString(body.substrate_group);
        return one ? [one] : [];
    }
    return undefined;
}

async function replaceMaterialGroupMemberships(
    client: pg.PoolClient | pg.Pool,
    materialId: string,
    groupIds: string[]
): Promise<void> {
    const deduped: string[] = [];
    for (const id of groupIds) {
        const s = id.trim();
        if (s && !deduped.includes(s)) deduped.push(s);
    }
    await client.query(`DELETE FROM public.material_group_memberships WHERE material_id = $1`, [
        materialId,
    ]);
    for (let i = 0; i < deduped.length; i++) {
        await client.query(
            `INSERT INTO public.material_group_memberships (material_id, group_id, sort_order)
             VALUES ($1, $2, $3)`,
            [materialId, deduped[i], i]
        );
    }
    const primary = deduped[0] ?? null;
    await client.query(`UPDATE public.materials SET substrate_group = $2 WHERE material_id = $1`, [
        materialId,
        primary,
    ]);
}

export const stockRouter = Router();

export function normalizeBarcode(raw: string): string {
    return raw.trim();
}

/** Case-insensitive exact match on internal / vendor / alternate barcode columns. */
export async function findMaterialIdsByBarcode(
    pool: pg.Pool,
    scan: string
): Promise<string[]> {
    const s = normalizeBarcode(scan);
    if (!s) return [];
    const { rows } = await pool.query<{ material_id: string }>(
        `SELECT DISTINCT m.material_id
         FROM public.materials m
         WHERE
           (m.internal_barcode IS NOT NULL AND trim(m.internal_barcode) <> ''
             AND lower(trim(m.internal_barcode)) = lower($1::text))
           OR (m.vendor_barcode IS NOT NULL AND trim(m.vendor_barcode) <> ''
             AND lower(trim(m.vendor_barcode)) = lower($1::text))
           OR (m.alternate_barcode IS NOT NULL AND trim(m.alternate_barcode) <> ''
             AND lower(trim(m.alternate_barcode)) = lower($1::text))`,
        [s]
    );
    return rows.map((r) => r.material_id);
}

export type MaterialBarcodeScanResult =
    | { kind: "none" }
    | { kind: "ambiguous"; materialIds: string[] }
    | { kind: "single"; materialId: string; material: Record<string, unknown> };

export async function resolveMaterialBarcodeScan(
    pool: pg.Pool,
    rawScan: string
): Promise<MaterialBarcodeScanResult> {
    const ids = await findMaterialIdsByBarcode(pool, rawScan);
    if (ids.length === 0) return { kind: "none" };
    if (ids.length > 1) return { kind: "ambiguous", materialIds: ids };
    const materialId = ids[0]!;
    const { rows } = await pool.query(
        `${MATERIAL_SELECT_LIST} WHERE m.material_id = $1`,
        [materialId]
    );
    const material = rows[0] as Record<string, unknown> | undefined;
    if (!material) return { kind: "none" };
    return { kind: "single", materialId, material };
}

function stockMeta() {
    return {
        allowlistedTables: [...ALLOWED_STOCK_TABLES],
        jobmanagerUrlConfigured: Boolean(getPrintOsDatabaseUrl()?.trim()),
    };
}

function parseMaterialsCompanyFilter(raw: unknown): "all" | "nl" | "np" {
    if (typeof raw !== "string") return "all";
    const t = raw.trim();
    if (!t || t.toLowerCase() === "all") return "all";
    if (t === "NL Material") return "nl";
    if (t === "NP Material") return "np";
    return "all";
}

function materialsCatalogFilterSql(): string {
    return `($1::text = '' OR
                    m.material_code ILIKE '%' || $1 || '%' OR
                    m.material_name ILIKE '%' || $1 || '%' OR
                    m.material_id ILIKE '%' || $1 || '%' OR
                    COALESCE(m.aliases, '') ILIKE '%' || $1 || '%' OR
                    COALESCE(m.internal_barcode, '') ILIKE '%' || $1 || '%' OR
                    COALESCE(m.vendor_barcode, '') ILIKE '%' || $1 || '%' OR
                    COALESCE(m.alternate_barcode, '') ILIKE '%' || $1 || '%' OR
                    COALESCE(m.location, '') ILIKE '%' || $1 || '%')
               AND ($2::boolean = false OR m.is_active IS NULL OR m.is_active = true)
               AND (
                 $3::text = 'all'
                 OR ($3::text = 'nl' AND COALESCE(m.company, 'NL Material') = 'NL Material')
                 OR ($3::text = 'np' AND m.company = 'NP Material')
               )`;
}

stockRouter.get("/meta", (_req, res) => {
    res.json(stockMeta());
});

stockRouter.get("/material-groups", async (req, res) => {
    const pool = getPrintOsPool();
    const catalog =
        req.query.catalog === "1" ||
        req.query.catalog === "true" ||
        req.query.scope === "catalog";

    if (catalog) {
        const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const activeOnly =
            typeof req.query.activeOnly === "string"
                ? req.query.activeOnly !== "false" && req.query.activeOnly !== "0"
                : true;
        const companyMode = parseMaterialsCompanyFilter(req.query.company);
        const filterSql = materialsCatalogFilterSql();
        try {
            const { rows } = await pool.query(
                `WITH matched AS (
                    SELECT mgm.group_id AS sid,
                           g.group_name,
                           g.group_description,
                           g.group_color,
                           g.sort_order
                    FROM public.material_group_memberships mgm
                    INNER JOIN public.materials m ON m.material_id = mgm.material_id
                    LEFT JOIN public.material_groups g ON g.group_id = mgm.group_id
                    WHERE ${filterSql}
                )
                SELECT sid::text AS group_id,
                       COALESCE(max(group_name)::text, max(sid::text)) AS group_name,
                       max(group_description) AS group_description,
                       max(group_color) AS group_color,
                       max(sort_order) AS sort_order,
                       count(*)::int AS material_count
                FROM matched
                GROUP BY sid
                ORDER BY max(sort_order) ASC NULLS LAST,
                         COALESCE(max(group_name)::text, max(sid::text)) ASC`,
                [qRaw, activeOnly, companyMode]
            );
            res.json(rows);
        } catch (e) {
            if (isUndefinedTableError(e)) {
                res.status(503).json({
                    error: 'Table "materials" or "material_groups" not found on this database. Set JOBMANAGER_DATABASE_URL if stock tables live on jobmanager.',
                    ...stockMeta(),
                });
                return;
            }
            if (isUndefinedColumnError(e)) {
                const msg = String((e as { message?: string }).message || "");
                if (msg.includes("company")) {
                    res.status(503).json({
                        error:
                            'Column "company" missing on public.materials. Run server/db/migrations-jobmanager/001-materials-company.sql on the jobmanager database.',
                        ...stockMeta(),
                    });
                    return;
                }
                res.status(503).json({
                    error:
                        "Barcode columns missing on materials. Run npm run run-migrations (038-materials-barcodes).",
                    ...stockMeta(),
                });
                return;
            }
            console.error("[stock] material-groups (catalog)", e);
            res.status(500).json({ error: "Failed to load material groups for catalog" });
        }
        return;
    }

    try {
        const { rows } = await pool.query(
            `SELECT group_id, group_name, group_description, group_color, sort_order
             FROM public.material_groups
             ORDER BY sort_order ASC NULLS LAST, group_name ASC`
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "material_groups" not found on this database. Point JOBMANAGER_DATABASE_URL at jobmanager if stock lives there.',
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] material-groups", e);
        res.status(500).json({ error: "Failed to load material groups" });
    }
});

const GROUP_COLOR_PALETTE = ["#4A90E2", "#7ED321", "#F5A623", "#BD10E0", "#50E3C2", "#B8E986"];

function slugifyGroupId(name: string): string {
    const base = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 72);
    return base || "group";
}

function normalizeGroupId(raw: string): string | null {
    const s = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (!s || !/^[a-z][a-z0-9_]*$/.test(s)) return null;
    return s.slice(0, 80);
}

async function allocateGroupId(pool: pg.Pool, preferred: string): Promise<string> {
    let id = preferred;
    for (let i = 0; i < 24; i++) {
        const { rows } = await pool.query(`SELECT 1 FROM public.material_groups WHERE group_id = $1 LIMIT 1`, [
            id,
        ]);
        if (rows.length === 0) return id;
        const suffix = `_${i + 2}`;
        id = `${preferred.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
    }
    throw new Error("Could not allocate a unique group_id");
}

stockRouter.post("/material-groups", async (req, res) => {
    const body = req.body as PatchBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "JSON body required" });
        return;
    }

    const group_name = optionalString(body.group_name);
    if (!group_name) {
        res.status(400).json({ error: "group_name is required" });
        return;
    }

    const rawId = optionalString(body.group_id);
    let group_id = rawId ? normalizeGroupId(rawId) : slugifyGroupId(group_name);
    if (!group_id) {
        res.status(400).json({
            error: "group_id must be lowercase letters, digits, and underscores (e.g. label_rolls)",
        });
        return;
    }

    const group_description = optionalString(body.group_description) ?? null;
    const group_color = optionalString(body.group_color) ?? null;
    const sortFromBody = optionalInt(body.sort_order);

    const pool = getPrintOsPool();
    try {
        group_id = await allocateGroupId(pool, group_id);

        let sort_order = sortFromBody;
        if (sort_order === undefined || sort_order === null) {
            const maxRow = await pool.query<{ next: number }>(
                `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM public.material_groups`
            );
            const next = maxRow.rows[0]?.next ?? 1;
            sort_order = next;
        }

        let color = group_color;
        if (!color) {
            const idx = Math.max(0, (sort_order ?? 1) - 1) % GROUP_COLOR_PALETTE.length;
            color = GROUP_COLOR_PALETTE[idx]!;
        }

        await pool.query(
            `INSERT INTO public.material_groups (group_id, group_name, group_description, group_color, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [group_id, group_name, group_description, color, sort_order]
        );

        const { rows } = await pool.query(
            `SELECT group_id, group_name, group_description, group_color, sort_order
             FROM public.material_groups
             WHERE group_id = $1`,
            [group_id]
        );
        res.status(201).json(rows[0] ?? { group_id, group_name });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "material_groups" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        if (isUniqueViolation(e)) {
            res.status(409).json({ error: "A material group with this id already exists" });
            return;
        }
        console.error("[stock] create material-group", e);
        res.status(500).json({ error: "Failed to create material group" });
    }
});

stockRouter.get("/material-by-barcode", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const pool = getPrintOsPool();
    try {
        const result = await resolveMaterialBarcodeScan(pool, code);
        if (result.kind === "none") {
            res.status(404).json({ error: "No material matches this barcode" });
            return;
        }
        if (result.kind === "ambiguous") {
            res.status(409).json({
                error: "Ambiguous material barcode",
                materialIds: result.materialIds,
            });
            return;
        }
        res.json({ material: result.material });
    } catch (e) {
        if (isUndefinedTableError(e) || isUndefinedColumnError(e)) {
            res.status(503).json({
                error:
                    "Barcode columns missing or materials table absent. Run npm run run-migrations (038-materials-barcodes).",
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] material-by-barcode", e);
        res.status(500).json({ error: "Failed to resolve barcode" });
    }
});

stockRouter.get("/materials", async (req, res) => {
    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const activeOnly =
        typeof req.query.activeOnly === "string"
            ? req.query.activeOnly !== "false" && req.query.activeOnly !== "0"
            : true;
    const companyMode = parseMaterialsCompanyFilter(req.query.company);
    const groupIds = parseGroupIdsQuery(req);

    const pool = getPrintOsPool();
    try {
        const filterSql = materialsCatalogFilterSql();
        const { rows } = await pool.query(
            `${MATERIAL_SELECT_LIST}
             WHERE ${filterSql}
               AND (
                 cardinality($4::text[]) = 0
                 OR EXISTS (
                   SELECT 1 FROM public.material_group_memberships mgm_f
                   WHERE mgm_f.material_id = m.material_id
                     AND mgm_f.group_id = ANY($4::text[])
                 )
                 OR (
                   m.substrate_group IS NOT NULL
                   AND m.substrate_group::text = ANY($4::text[])
                   AND NOT EXISTS (
                     SELECT 1 FROM public.material_group_memberships mgm_f2
                     WHERE mgm_f2.material_id = m.material_id
                   )
                 )
               )
             ORDER BY low_stock DESC, m.material_name ASC NULLS LAST`,
            [qRaw, activeOnly, companyMode, groupIds]
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "materials" not found on this database. Set JOBMANAGER_DATABASE_URL if stock tables live on jobmanager.',
                ...stockMeta(),
            });
            return;
        }
        if (isUndefinedColumnError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("company")) {
                res.status(503).json({
                    error:
                        'Column "company" missing on public.materials. Run server/db/migrations-jobmanager/001-materials-company.sql on the jobmanager database.',
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({
                error:
                    "Barcode columns missing on materials. Run npm run run-migrations (038-materials-barcodes).",
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] materials", e);
        res.status(500).json({ error: "Failed to load materials" });
    }
});

stockRouter.get("/materials/:materialId", async (req, res) => {
    const materialId = String(req.params.materialId || "").trim();
    if (!materialId) {
        res.status(400).json({ error: "materialId required" });
        return;
    }
    const pool = getPrintOsPool();
    try {
        const { rows } = await pool.query(`${MATERIAL_SELECT_LIST} WHERE m.material_id = $1`, [
            materialId,
        ]);
        if (rows.length === 0) {
            res.status(404).json({ error: "Material not found" });
            return;
        }
        res.json(rows[0]);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({ error: "Materials table not found", ...stockMeta() });
            return;
        }
        if (isUndefinedColumnError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("company")) {
                res.status(503).json({
                    error:
                        'Column "company" missing on public.materials. Run server/db/migrations-jobmanager/001-materials-company.sql on the jobmanager database.',
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({
                error:
                    "Barcode columns missing on materials. Run npm run run-migrations (038-materials-barcodes).",
                ...stockMeta(),
            });
            return;
        }
        res.status(500).json({ error: "Failed to load material" });
    }
});

stockRouter.get("/materials/:materialId/movements", async (req, res) => {
    const materialId = String(req.params.materialId || "").trim();
    if (!materialId) {
        res.status(400).json({ error: "materialId required" });
        return;
    }
    let limit = 100;
    if (typeof req.query.limit === "string" && req.query.limit.trim() !== "") {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n)) limit = Math.min(500, Math.max(1, n));
    }
    let offset = 0;
    if (typeof req.query.offset === "string" && req.query.offset.trim() !== "") {
        const n = parseInt(req.query.offset, 10);
        if (Number.isFinite(n)) offset = Math.max(0, n);
    }

    const pool = getPrintOsPool();
    try {
        const { rows } = await pool.query(
            `SELECT movement_id::text AS movement_id,
                    material_id,
                    requested_delta::text AS requested_delta,
                    applied_delta::text AS applied_delta,
                    stock_before::text AS stock_before,
                    stock_after::text AS stock_after,
                    created_at
             FROM public.material_stock_movements
             WHERE material_id = $1
             ORDER BY created_at DESC, movement_id DESC
             LIMIT $2 OFFSET $3`,
            [materialId, limit, offset]
        );
        res.json({ movements: rows, limit, offset });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error:
                    'Table "material_stock_movements" not found. Run npm run run-migrations (039-material-stock-movements).',
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] material movements", e);
        res.status(500).json({ error: "Failed to load stock movements" });
    }
});

/** Atomic stock change: `delta` added to COALESCE(stock,0); result clamped at 0 (issue overshoot). */
stockRouter.post("/materials/:materialId/adjust", async (req, res) => {
    const materialId = String(req.params.materialId || "").trim();
    if (!materialId) {
        res.status(400).json({ error: "materialId required" });
        return;
    }
    const body = req.body as Record<string, unknown>;
    const rawDelta = body?.delta;
    const delta =
        typeof rawDelta === "number" && Number.isFinite(rawDelta)
            ? rawDelta
            : typeof rawDelta === "string" && rawDelta.trim() !== ""
              ? parseFloat(rawDelta)
              : NaN;
    if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ error: "Body must include a non-zero numeric delta (positive = receive, negative = take out)" });
        return;
    }

    const pool = getPrintOsPool();
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query<{
            requested_delta: string;
            applied_delta: string;
            baseline: string;
            new_stock: string;
        }>(
            `WITH cur AS (
                SELECT material_id, stock,
                       COALESCE(stock, 0)::numeric AS baseline
                FROM public.materials
                WHERE material_id = $1
             ),
             calc AS (
                SELECT material_id, stock AS old_stock_raw, baseline,
                       ($2::numeric) AS requested_delta,
                       GREATEST(0::numeric, baseline + ($2::numeric)) AS new_stock
                FROM cur
             )
             UPDATE public.materials m
             SET stock = calc.new_stock
             FROM calc
             WHERE m.material_id = calc.material_id
             RETURNING
               calc.requested_delta::text AS requested_delta,
               (calc.new_stock - calc.baseline)::text AS applied_delta,
               calc.baseline::text AS baseline,
               calc.new_stock::text AS new_stock`,
            [materialId, delta]
        );
        if (rows.length === 0) {
            await client.query("ROLLBACK");
            res.status(404).json({ error: "Material not found" });
            return;
        }
        const r = rows[0]!;
        const applied = parseFloat(r.applied_delta);
        const baseline = parseFloat(r.baseline);
        const newStock = parseFloat(r.new_stock);

        await client.query(
            `INSERT INTO public.material_stock_movements (
                material_id, requested_delta, applied_delta, stock_before, stock_after
            ) VALUES ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric)`,
            [materialId, delta, applied, baseline, newStock]
        );
        await client.query("COMMIT");

        const clamped = delta < 0 && applied > delta + 1e-9;

        const { rows: fullRows } = await pool.query(`${MATERIAL_SELECT_LIST} WHERE m.material_id = $1`, [
            materialId,
        ]);
        const material = fullRows[0] ?? { material_id: materialId };
        res.json({
            material,
            requested_delta: delta,
            applied_delta: applied,
            clamped,
        });
    } catch (e) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* ignore */
        }
        if (isUndefinedTableError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("material_stock_movements")) {
                res.status(503).json({
                    error:
                        'Table "material_stock_movements" not found. Run npm run run-migrations (039-material-stock-movements).',
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({ error: "Materials table not found", ...stockMeta() });
            return;
        }
        if (isUndefinedColumnError(e)) {
            res.status(503).json({
                error:
                    "Adjust failed: missing column. Run npm run run-migrations for materials/stock columns.",
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] adjust material", e);
        res.status(500).json({ error: "Failed to adjust stock" });
    } finally {
        client.release();
    }
});

stockRouter.get("/reorder-candidates", async (req, res) => {
    const activeOnly =
        typeof req.query.activeOnly === "string"
            ? req.query.activeOnly !== "false" && req.query.activeOnly !== "0"
            : true;
    const companyMode = parseMaterialsCompanyFilter(req.query.company);
    let factor = 1;
    if (typeof req.query.targetFactor === "string" && req.query.targetFactor.trim() !== "") {
        const f = parseFloat(req.query.targetFactor);
        if (Number.isFinite(f) && f > 0) factor = f;
    }

    const pool = getPrintOsPool();
    try {
        const { rows } = await pool.query(
            `SELECT inner.*,
                    sp.minimum_order_quantity AS supplier_minimum_order_quantity,
                    sp.cost_per_unit AS supplier_cost_per_unit,
                    CASE
                      WHEN inner.reorder_level IS NULL OR inner.stock IS NULL THEN NULL
                      ELSE GREATEST(
                        0::numeric,
                        CEIL(($4::numeric * inner.reorder_level::numeric) - inner.stock::numeric)
                      )
                    END AS suggested_order_qty_before_moq,
                    CASE
                      WHEN inner.reorder_level IS NULL OR inner.stock IS NULL THEN NULL
                      ELSE GREATEST(
                        GREATEST(
                          0::numeric,
                          CEIL(($4::numeric * inner.reorder_level::numeric) - inner.stock::numeric)
                        ),
                        COALESCE(sp.minimum_order_quantity::numeric, 0::numeric)
                      )
                    END AS suggested_order_qty
             FROM (
               ${MATERIAL_SELECT_LIST}
               WHERE ($1::text = '' OR
                      m.material_code ILIKE '%' || $1 || '%' OR
                      m.material_name ILIKE '%' || $1 || '%' OR
                      m.material_id ILIKE '%' || $1 || '%')
                 AND ($2::boolean = false OR m.is_active IS NULL OR m.is_active = true)
                 AND (
                   $3::text = 'all'
                   OR ($3::text = 'nl' AND COALESCE(m.company, 'NL Material') = 'NL Material')
                   OR ($3::text = 'np' AND m.company = 'NP Material')
                 )
                 AND m.stock IS NOT NULL
                 AND m.reorder_level IS NOT NULL
                 AND m.stock <= m.reorder_level
             ) inner
             LEFT JOIN LATERAL (
               SELECT p.minimum_order_quantity, p.cost_per_unit
               FROM public.material_supplier_pricing p
               WHERE p.material_id = inner.material_id
                 AND (p.is_active IS NULL OR p.is_active = true)
               ORDER BY (p.is_preferred_supplier IS TRUE) DESC,
                        p.cost_per_unit ASC NULLS LAST
               LIMIT 1
             ) sp ON true
             ORDER BY inner.material_name ASC NULLS LAST`,
            ["", activeOnly, companyMode, factor]
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("material_supplier_pricing")) {
                res.json([]);
                return;
            }
            res.status(503).json({
                error: 'Table "materials" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        if (isUndefinedColumnError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("company")) {
                res.status(503).json({
                    error:
                        'Column "company" missing on public.materials. Run server/db/migrations-jobmanager/001-materials-company.sql on the jobmanager database.',
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({
                error:
                    "Reorder query failed: missing column. Run npm run run-migrations for stock-related columns.",
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] reorder-candidates", e);
        res.status(500).json({ error: "Failed to load reorder candidates" });
    }
});

type PatchBody = Record<string, unknown>;

function optionalString(v: unknown): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
}

function optionalNum(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : undefined;
}

function optionalInt(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "number" && Number.isInteger(v)) return v;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : undefined;
}

function optionalBool(v: unknown): boolean | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === "boolean") return v;
    if (v === "true" || v === 1) return true;
    if (v === "false" || v === 0) return false;
    return undefined;
}

function parseCreateCompany(raw: unknown): "NL Material" | "NP Material" {
    if (raw === "NP Material") return "NP Material";
    return "NL Material";
}

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
    );
}

async function allocateMaterialId(pool: pg.Pool): Promise<string> {
    for (let i = 0; i < 12; i++) {
        const id = `MAT-APP-${randomBytes(5).toString("hex").toUpperCase()}`;
        const { rows } = await pool.query(`SELECT 1 FROM public.materials WHERE material_id = $1 LIMIT 1`, [id]);
        if (rows.length === 0) return id;
    }
    throw new Error("Could not allocate a unique material_id");
}

const CREATE_ALLOWED_KEYS = new Set([
    "material_id",
    "material_code",
    "material_name",
    "company",
    ...[
        "internal_barcode",
        "vendor_barcode",
        "alternate_barcode",
        "substrate_type",
        "adhesive_type",
        "handling",
        "coating",
        "grain_direction",
        "glossy_level",
        "pricing_unit",
        "substrate_group",
        "aliases",
        "location",
        "stock",
        "reorder_level",
        "width_mm",
        "length_mm",
        "cost_aud",
        "weight_gsm",
        "lead_time_days",
        "conductive",
        "white_material",
        "is_active",
        "substrate_groups",
    ],
]);

stockRouter.post("/materials", async (req, res) => {
    const body = req.body as PatchBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "JSON body required" });
        return;
    }

    const unknownKeys = Object.keys(body).filter((k) => !CREATE_ALLOWED_KEYS.has(k));
    if (unknownKeys.length > 0) {
        res.status(400).json({ error: "Unknown or unsupported fields", unknownKeys });
        return;
    }

    const material_code = optionalString(body.material_code);
    if (!material_code) {
        res.status(400).json({ error: "material_code is required" });
        return;
    }

    const s = (k: string) => optionalString(body[k]);
    const n = (k: string) => optionalNum(body[k]);
    const i = (k: string) => optionalInt(body[k]);
    const b = (k: string) => optionalBool(body[k]);

    const material_name = s("material_name") ?? material_code;
    const company = parseCreateCompany(body.company);

    let material_id = s("material_id");
    const pool = getPrintOsPool();

    try {
        if (material_id) {
            const exists = await pool.query(`SELECT 1 FROM public.materials WHERE material_id = $1 LIMIT 1`, [
                material_id,
            ]);
            if (exists.rows.length > 0) {
                res.status(409).json({ error: "material_id already exists" });
                return;
            }
        } else {
            material_id = await allocateMaterialId(pool);
        }

        const stockVal = "stock" in body ? n("stock") : 0;
        const reorderVal = "reorder_level" in body ? n("reorder_level") : 0;
        const leadVal = "lead_time_days" in body ? i("lead_time_days") : 7;
        const groupIdsForCreate = parseSubstrateGroupIdsFromBody(body);
        const primaryGroup =
            groupIdsForCreate !== undefined ? (groupIdsForCreate[0] ?? null) : (s("substrate_group") ?? null);

        await pool.query(
            `INSERT INTO public.materials (
               material_id, material_code, material_name,
               substrate_type, adhesive_type, handling,
               weight_gsm, width_mm, length_mm,
               coating, grain_direction, glossy_level,
               conductive, white_material,
               pricing_unit, substrate_group,
               stock, reorder_level, lead_time_days, cost_aud,
               aliases, is_active,
               internal_barcode, vendor_barcode, alternate_barcode,
               location,
               company
             ) VALUES (
               $1, $2, $3,
               $4, $5, $6,
               $7, $8, $9,
               $10, $11, $12,
               $13, $14,
               $15, $16,
               $17, $18, $19, $20,
               $21, $22,
               $23, $24, $25,
               $26,
               $27
             )`,
            [
                material_id,
                material_code,
                material_name,
                s("substrate_type") ?? "other",
                s("adhesive_type"),
                s("handling"),
                i("weight_gsm"),
                n("width_mm"),
                n("length_mm"),
                s("coating"),
                s("grain_direction"),
                s("glossy_level"),
                b("conductive") ?? false,
                b("white_material") ?? false,
                s("pricing_unit") ?? "each",
                primaryGroup,
                stockVal ?? 0,
                reorderVal ?? 0,
                leadVal ?? 7,
                n("cost_aud"),
                s("aliases"),
                b("is_active") ?? true,
                s("internal_barcode"),
                s("vendor_barcode"),
                s("alternate_barcode"),
                s("location"),
                company,
            ]
        );

        if (groupIdsForCreate !== undefined) {
            await replaceMaterialGroupMemberships(pool, material_id, groupIdsForCreate);
        } else if (primaryGroup) {
            await replaceMaterialGroupMemberships(pool, material_id, [primaryGroup]);
        }

        const { rows } = await pool.query(`${MATERIAL_SELECT_LIST} WHERE m.material_id = $1`, [material_id]);
        res.status(201).json(rows[0] ?? { material_id });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "materials" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        if (isUndefinedColumnError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("material_group_memberships")) {
                res.status(503).json({
                    error:
                        "Create failed: run npm run run-migrations (041-material-group-memberships) on the stock database.",
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({
                error:
                    "Create failed: missing column. Run npm run run-migrations for materials (barcodes, company).",
                ...stockMeta(),
            });
            return;
        }
        if (isUniqueViolation(e)) {
            res.status(409).json({ error: "A material with this id or unique code already exists" });
            return;
        }
        if (isForeignKeyViolation(e)) {
            res.status(409).json({
                error: "Invalid substrate_group or other reference — check material groups.",
            });
            return;
        }
        console.error("[stock] create material", e);
        res.status(500).json({ error: "Failed to create material" });
    }
});

function isForeignKeyViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23503"
    );
}

stockRouter.patch("/materials/:materialId", async (req, res) => {
    const materialId = String(req.params.materialId || "").trim();
    if (!materialId) {
        res.status(400).json({ error: "materialId required" });
        return;
    }
    const body = req.body as PatchBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "JSON body required" });
        return;
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    let p = 1;

    const push = (col: string, val: unknown) => {
        assignments.push(`${col} = $${p++}`);
        values.push(val);
    };

    const s = (k: string) => optionalString(body[k]);
    const n = (k: string) => optionalNum(body[k]);
    const i = (k: string) => optionalInt(body[k]);
    const b = (k: string) => optionalBool(body[k]);

    const groupIdsUpdate = parseSubstrateGroupIdsFromBody(body);

    const textKeys = [
        "internal_barcode",
        "vendor_barcode",
        "alternate_barcode",
        "material_code",
        "material_name",
        "substrate_type",
        "adhesive_type",
        "handling",
        "coating",
        "grain_direction",
        "glossy_level",
        "pricing_unit",
        "substrate_group",
        "aliases",
        "location",
    ] as const;
    for (const k of textKeys) {
        if (k === "substrate_group" && groupIdsUpdate !== undefined) continue;
        if (k in body) {
            const v = s(k);
            if (v !== undefined) push(k, v);
        }
    }

    if ("stock" in body) {
        const v = n("stock");
        if (v !== undefined) push("stock", v);
    }
    if ("reorder_level" in body) {
        const v = n("reorder_level");
        if (v !== undefined) push("reorder_level", v);
    }
    if ("width_mm" in body) {
        const v = n("width_mm");
        if (v !== undefined) push("width_mm", v);
    }
    if ("length_mm" in body) {
        const v = n("length_mm");
        if (v !== undefined) push("length_mm", v);
    }
    if ("cost_aud" in body) {
        const v = n("cost_aud");
        if (v !== undefined) push("cost_aud", v);
    }
    if ("weight_gsm" in body) {
        const v = i("weight_gsm");
        if (v !== undefined) push("weight_gsm", v);
    }
    if ("lead_time_days" in body) {
        const v = i("lead_time_days");
        if (v !== undefined) push("lead_time_days", v);
    }
    if ("conductive" in body) {
        const v = b("conductive");
        if (v !== undefined) push("conductive", v);
    }
    if ("white_material" in body) {
        const v = b("white_material");
        if (v !== undefined) push("white_material", v);
    }
    if ("is_active" in body) {
        const v = b("is_active");
        if (v !== undefined) push("is_active", v);
    }

    const unknownKeys = Object.keys(body).filter(
        (k) =>
            ![
                ...textKeys,
                "stock",
                "reorder_level",
                "width_mm",
                "length_mm",
                "cost_aud",
                "weight_gsm",
                "lead_time_days",
                "conductive",
                "white_material",
                "is_active",
                "location",
                "substrate_groups",
            ].includes(k)
    );
    if (unknownKeys.length > 0) {
        res.status(400).json({ error: "Unknown or unsupported fields", unknownKeys });
        return;
    }

    if (assignments.length === 0 && groupIdsUpdate === undefined) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
    }

    values.push(materialId);
    const pool = getPrintOsPool();
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (assignments.length > 0) {
            const upd = await client.query(
                `UPDATE public.materials SET ${assignments.join(", ")} WHERE material_id = $${p} RETURNING material_id`,
                values
            );
            if (upd.rowCount === 0) {
                await client.query("ROLLBACK");
                res.status(404).json({ error: "Material not found" });
                return;
            }
        } else {
            const exists = await client.query(
                `SELECT 1 FROM public.materials WHERE material_id = $1 LIMIT 1`,
                [materialId]
            );
            if (exists.rows.length === 0) {
                await client.query("ROLLBACK");
                res.status(404).json({ error: "Material not found" });
                return;
            }
        }
        if (groupIdsUpdate !== undefined) {
            await replaceMaterialGroupMemberships(client, materialId, groupIdsUpdate);
        }
        await client.query("COMMIT");
        const { rows } = await pool.query(`${MATERIAL_SELECT_LIST} WHERE m.material_id = $1`, [
            materialId,
        ]);
        res.json(rows[0] ?? { material_id: materialId });
    } catch (e) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* ignore */
        }
        if (isUndefinedColumnError(e)) {
            const msg = String((e as { message?: string }).message || "");
            if (msg.includes("material_group_memberships")) {
                res.status(503).json({
                    error:
                        "Update failed: run npm run run-migrations (041-material-group-memberships) on the stock database.",
                    ...stockMeta(),
                });
                return;
            }
            res.status(503).json({
                error:
                    "Update failed: missing column (run npm run run-migrations for 038-materials-barcodes).",
                ...stockMeta(),
            });
            return;
        }
        if (isForeignKeyViolation(e)) {
            res.status(409).json({
                error: "Invalid substrate_group — check material groups.",
            });
            return;
        }
        console.error("[stock] patch material", e);
        res.status(500).json({ error: "Failed to update material" });
    } finally {
        client.release();
    }
});

/** Removes pricing / conversions / print profiles for this id (allowlisted), then the material row. */
stockRouter.delete("/materials/:materialId", async (req, res) => {
    const materialId = String(req.params.materialId || "").trim();
    if (!materialId) {
        res.status(400).json({ error: "materialId required" });
        return;
    }

    const pool = getPrintOsPool();
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM public.material_supplier_pricing WHERE material_id = $1`, [
            materialId,
        ]);
        await client.query(`DELETE FROM public.material_conversions WHERE material_id = $1`, [
            materialId,
        ]);
        await client.query(`DELETE FROM public.material_print_profiles WHERE material_id = $1`, [
            materialId,
        ]);
        await client.query("SAVEPOINT stock_delete_before_movements");
        try {
            await client.query(`DELETE FROM public.material_stock_movements WHERE material_id = $1`, [
                materialId,
            ]);
        } catch (moveErr) {
            if (isUndefinedTableError(moveErr)) {
                await client.query("ROLLBACK TO SAVEPOINT stock_delete_before_movements");
            } else {
                throw moveErr;
            }
        }
        const del = await client.query(`DELETE FROM public.materials WHERE material_id = $1`, [
            materialId,
        ]);
        await client.query("COMMIT");
        if (del.rowCount === 0) {
            res.status(404).json({ error: "Material not found" });
            return;
        }
        res.status(204).end();
    } catch (e) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* ignore */
        }
        if (isUndefinedTableError(e)) {
            res.status(503).json({ error: "Materials table not found", ...stockMeta() });
            return;
        }
        if (isForeignKeyViolation(e)) {
            res.status(409).json({
                error:
                    "Cannot delete: other database objects still reference this material. Remove those links first.",
            });
            return;
        }
        console.error("[stock] delete material", e);
        res.status(500).json({ error: "Failed to delete material" });
    } finally {
        client.release();
    }
});

stockRouter.get("/supplier-pricing", async (req, res) => {
    const materialId =
        typeof req.query.materialId === "string" ? req.query.materialId.trim() : "";

    const pool = getPrintOsPool();
    try {
        if (materialId) {
            const { rows } = await pool.query(
                `SELECT *
                 FROM public.material_supplier_pricing
                 WHERE material_id = $1
                 ORDER BY is_active DESC, updated_at DESC NULLS LAST`,
                [materialId]
            );
            res.json(rows);
            return;
        }
        const { rows } = await pool.query(
            `SELECT *
             FROM public.material_supplier_pricing
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
             LIMIT 500`
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "material_supplier_pricing" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] supplier-pricing", e);
        res.status(500).json({ error: "Failed to load supplier pricing" });
    }
});

stockRouter.get("/conversions", async (_req, res) => {
    const pool = getPrintOsPool();
    try {
        const { rows } = await pool.query(
            `SELECT conversion_id, material_id, from_unit, to_unit, conversion_factor, notes, created_at
             FROM public.material_conversions
             ORDER BY created_at DESC NULLS LAST`
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "material_conversions" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] conversions", e);
        res.status(500).json({ error: "Failed to load conversions" });
    }
});

stockRouter.get("/print-profiles", async (_req, res) => {
    const pool = getPrintOsPool();
    try {
        const { rows } = await pool.query(
            `SELECT material_print_profile_id, material_id, press_profile_id
             FROM public.material_print_profiles
             ORDER BY material_print_profile_id ASC`
        );
        res.json(rows);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            res.status(503).json({
                error: 'Table "material_print_profiles" not found on this database.',
                ...stockMeta(),
            });
            return;
        }
        console.error("[stock] print-profiles", e);
        res.status(500).json({ error: "Failed to load print profiles" });
    }
});
