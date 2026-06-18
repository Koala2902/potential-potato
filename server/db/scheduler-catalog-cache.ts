import { prisma } from './prisma.js';

const DEFAULT_TTL_MS = 60_000;

function catalogTtlMs(): number {
    const n = Number(process.env.SCHEDULER_CATALOG_CACHE_MS);
    if (Number.isFinite(n) && n >= 0) {
        return n;
    }
    return DEFAULT_TTL_MS;
}

type MachineRow = {
    id: string;
    name: string;
    displayName: string;
    enabled: boolean;
    sortOrder: number;
};

type OperationRow = {
    id: string;
    machineId: string;
    name: string;
    plannerOperationId: string | null;
    notes: string | null;
    sortOrder: number;
};

let snapshotAt = 0;
let machines: MachineRow[] = [];
let operations: OperationRow[] = [];

/** Clear cached scheduler.Machine / Operation rows (e.g. after config API mutations). */
export function invalidateSchedulerCatalogCache(): void {
    snapshotAt = 0;
    machines = [];
    operations = [];
}

async function refreshSnapshot(): Promise<void> {
    const [mRows, oRows] = await Promise.all([
        prisma.machine.findMany({
            select: {
                id: true,
                name: true,
                displayName: true,
                enabled: true,
                sortOrder: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        prisma.operation.findMany({
            where: { enabled: true },
            select: {
                id: true,
                machineId: true,
                name: true,
                plannerOperationId: true,
                notes: true,
                sortOrder: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        }),
    ]);
    machines = mRows;
    operations = oRows;
    snapshotAt = Date.now();
}

async function ensureFresh(): Promise<void> {
    const ttl = catalogTtlMs();
    if (ttl === 0 || !snapshotAt || Date.now() - snapshotAt > ttl) {
        await refreshSnapshot();
    }
}

/** All machines (enabled + disabled), for production bucket merge / alias resolution. */
export async function getCachedSchedulerMachinesForMerge(): Promise<
    Array<{ id: string; name: string; displayName: string }>
> {
    await ensureFresh();
    return machines.map((m) => ({
        id: m.id,
        name: m.name,
        displayName: m.displayName,
    }));
}

/** Enabled machines in UI list order (GET /api/machines). */
export async function getCachedSchedulerMachinesForApi(): Promise<MachineRow[]> {
    await ensureFresh();
    return machines
        .filter((m) => m.enabled)
        .slice()
        .sort((a, b) => {
            if (a.sortOrder !== b.sortOrder) {
                return a.sortOrder - b.sortOrder;
            }
            return a.name.localeCompare(b.name);
        });
}

/** `scheduler.Machine.name` is unique; matches Prisma `findUnique({ where: { name } })`. */
export async function getCachedSchedulerMachineByUniqueName(
    name: string
): Promise<{ id: string; name: string } | null> {
    const raw = name.trim();
    if (!raw) {
        return null;
    }
    await ensureFresh();
    const lower = raw.toLowerCase();
    const m =
        machines.find((x) => x.name === raw) ?? machines.find((x) => x.name.toLowerCase() === lower);
    return m ? { id: m.id, name: m.name } : null;
}

/**
 * First enabled operation whose name contains "print" (case-insensitive), ordered by sortOrder asc, id asc.
 * Matches previous `getPrintOperationId` Prisma query.
 */
export async function getCachedSchedulerPrintOperationId(): Promise<string> {
    await ensureFresh();
    const candidates = operations.filter((o) => o.name.toLowerCase().includes('print'));
    candidates.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
            return a.sortOrder - b.sortOrder;
        }
        return a.id.localeCompare(b.id);
    });
    const op = candidates[0];
    if (op) {
        return op.id.toLowerCase();
    }
    return 'op001';
}

export interface ScanCatalogOperationRow {
    scheduler_operation_id: string;
    planner_operation_id: string | null;
    operation_name: string;
    description?: string;
    created_at?: string;
}

/** Enabled operations for one press (scan picker). */
export async function getCachedSchedulerOperationsForMachine(
    machineId: string
): Promise<ScanCatalogOperationRow[]> {
    const mid = machineId.trim();
    if (!mid) {
        return [];
    }
    await ensureFresh();
    const filtered = operations.filter((o) => o.machineId === mid);
    filtered.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
            return a.sortOrder - b.sortOrder;
        }
        return a.id.localeCompare(b.id);
    });
    return filtered.map((o) => ({
        scheduler_operation_id: o.id,
        planner_operation_id: o.plannerOperationId ?? null,
        operation_name: o.name,
        description: o.notes ?? undefined,
        created_at: undefined,
    }));
}

/** Highest-`sortOrder` enabled operation matching planner ids; used for routing. */
export async function resolveMachineIdForPlannerOperationIds(
    plannerOperationIds: string[]
): Promise<string | null> {
    const ids = plannerOperationIds.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (ids.length === 0) {
        return null;
    }
    await ensureFresh();
    const idSet = new Set(ids);
    const matching = operations.filter((o) => {
        if (idSet.has(o.id.toLowerCase())) {
            return true;
        }
        const po = o.plannerOperationId?.trim().toLowerCase();
        return po != null && po !== '' && idSet.has(po);
    });
    matching.sort((a, b) => b.sortOrder - a.sortOrder);
    return matching[0]?.machineId ?? null;
}
