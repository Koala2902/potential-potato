import { Pencil, Plus, Trash2, X, ClipboardCopy, MinusCircle, PlusCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewportProfile } from '../../hooks/useViewportProfile';

import {
    adjustStockMaterial,
    createStockMaterial,
    deleteStockMaterial,
    fetchStockMaterialByBarcode,
    fetchStockMaterialById,
    fetchStockMaterialGroups,
    fetchStockMaterialGroupsForCatalog,
    fetchStockMaterials,
    fetchStockMaterialMovements,
    fetchStockMeta,
    fetchStockReorderCandidates,
    fetchStockSupplierPricing,
    updateStockMaterial,
    type StockMaterialCreateBody,
    type StockMaterialGroupRef,
    type StockMaterialGroupRow,
    type StockMaterialMovementRow,
    type StockMaterialPatch,
    type StockMaterialRow,
    type StockMetaResponse,
    type StockReorderCandidateRow,
    type StockSupplierPricingRow,
} from '../../services/api';

import SubstrateGroupPicker from './SubstrateGroupPicker';
import './StockPage.css';
import './StockPageTouch.css';

export interface StockPageProps {
    focusMaterialId?: string | null;
    /** With `focusMaterialId`, opens take-out movement (not full editor). */
    focusOpenStockMovement?: 'issue' | null;
    onFocusConsumed?: () => void;
}

function formatNum(v: unknown): string {
    if (v == null) return '—';
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
    return String(v);
}

function strVal(v: unknown): string {
    if (v == null || v === '') return '';
    return String(v);
}

function numOr0(v: unknown): number {
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

function suggestedQtyForReorder(row: StockMaterialRow, factor: number): number {
    if (row.reorder_level == null || row.stock == null) return 0;
    return Math.max(0, Math.ceil(factor * numOr0(row.reorder_level) - numOr0(row.stock)));
}

function materialGroupRefs(row: StockMaterialRow): StockMaterialGroupRef[] {
    const raw = row.substrate_groups;
    if (Array.isArray(raw) && raw.length > 0) return raw;
    if (row.substrate_group) {
        return [
            {
                group_id: row.substrate_group,
                group_name: row.substrate_group_name ?? row.substrate_group,
                group_color: row.substrate_group_color ?? null,
            },
        ];
    }
    return [];
}

function groupIdsFromRow(row: StockMaterialRow): string[] {
    return materialGroupRefs(row).map((g) => g.group_id);
}

function sameGroupIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
}

function rowToReorderCandidate(row: StockMaterialRow, factor: number): StockReorderCandidateRow {
    const s = suggestedQtyForReorder(row, factor);
    return {
        ...row,
        suggested_order_qty: s,
        suggested_order_qty_before_moq: s,
        supplier_minimum_order_quantity: null,
        supplier_cost_per_unit: null,
    };
}

function emptyMaterialDraft(company: 'NL Material' | 'NP Material'): StockMaterialRow {
    return {
        material_id: '__new__',
        material_code: '',
        material_name: '',
        substrate_type: 'other',
        adhesive_type: null,
        handling: null,
        weight_gsm: null,
        width_mm: null,
        length_mm: null,
        coating: null,
        grain_direction: null,
        glossy_level: null,
        conductive: false,
        white_material: false,
        pricing_unit: 'each',
        substrate_group: null,
        substrate_groups: [],
        stock: 0,
        reorder_level: 0,
        lead_time_days: 7,
        cost_aud: null,
        aliases: null,
        is_active: true,
        internal_barcode: null,
        vendor_barcode: null,
        alternate_barcode: null,
        location: null,
        company,
        substrate_group_name: null,
        substrate_group_color: null,
        low_stock: false,
    };
}

function buildCreateBodyFromRow(row: StockMaterialRow, materialCode: string): StockMaterialCreateBody {
    return {
        material_code: materialCode,
        material_name: String(row.material_name ?? '').trim() || null,
        company: row.company === 'NP Material' ? 'NP Material' : 'NL Material',
        internal_barcode: row.internal_barcode,
        vendor_barcode: row.vendor_barcode,
        alternate_barcode: row.alternate_barcode,
        location: row.location,
        substrate_type: row.substrate_type?.trim() || 'other',
        adhesive_type: row.adhesive_type,
        handling: row.handling,
        coating: row.coating,
        grain_direction: row.grain_direction,
        glossy_level: row.glossy_level,
        weight_gsm: row.weight_gsm,
        width_mm: row.width_mm === '' || row.width_mm == null ? null : Number(row.width_mm),
        length_mm: row.length_mm === '' || row.length_mm == null ? null : Number(row.length_mm),
        cost_aud: row.cost_aud === '' || row.cost_aud == null ? null : Number(row.cost_aud),
        pricing_unit: row.pricing_unit,
        substrate_groups: groupIdsFromRow(row),
        lead_time_days: row.lead_time_days,
        aliases: row.aliases,
        conductive: row.conductive,
        white_material: row.white_material,
        is_active: row.is_active,
        stock: row.stock === '' || row.stock == null ? 0 : Number(row.stock),
        reorder_level: row.reorder_level === '' || row.reorder_level == null ? 0 : Number(row.reorder_level),
    };
}

function duplicateMaterialCode(row: StockMaterialRow): string {
    const base = String(row.material_code ?? row.material_id ?? 'material')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '');
    const safeBase = base || 'material';
    const unique = Date.now().toString(36).slice(-5);
    return `${safeBase}-copy-${unique}`;
}

const MOVEMENT_PAGE_SIZE = 100;

function movementAppliedNum(m: StockMaterialMovementRow): number {
    return Number(m.applied_delta);
}

function movementDirectionLabel(m: StockMaterialMovementRow): string {
    const n = movementAppliedNum(m);
    if (!Number.isFinite(n) || n === 0) return '—';
    return n > 0 ? 'Receive' : 'Take out';
}

function movementWasClamped(m: StockMaterialMovementRow): boolean {
    return Math.abs(Number(m.requested_delta) - Number(m.applied_delta)) > 1e-9;
}

function formatMovementWhen(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return iso;
    }
}

function csvEscapeCell(v: string): string {
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
}

export default function StockPage({ focusMaterialId, focusOpenStockMovement, onFocusConsumed }: StockPageProps) {
    const viewportProfile = useViewportProfile();
    const isTouch = viewportProfile === 'touch';

    const [meta, setMeta] = useState<StockMetaResponse | null>(null);
    const [materials, setMaterials] = useState<StockMaterialRow[]>([]);
    /** Full `material_groups` rows (e.g. editor substrate group dropdown). */
    const [groups, setGroups] = useState<StockMaterialGroupRow[]>([]);
    /** Groups that appear on ≥1 material with current search / company / active filters. */
    const [catalogGroups, setCatalogGroups] = useState<StockMaterialGroupRow[]>([]);
    const [pricing, setPricing] = useState<StockSupplierPricingRow[]>([]);
    const [movements, setMovements] = useState<StockMaterialMovementRow[]>([]);
    const [movementsLoading, setMovementsLoading] = useState(false);
    const [movementsLoadingMore, setMovementsLoadingMore] = useState(false);
    const [movementsError, setMovementsError] = useState<string | null>(null);
    const [movementsHasMore, setMovementsHasMore] = useState(false);
    const [movementHistoryTick, setMovementHistoryTick] = useState(0);
    const [loading, setLoading] = useState(true);
    const [pricingLoading, setPricingLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [q, setQ] = useState('');
    const [activeOnly, setActiveOnly] = useState(true);
    const [companyScope, setCompanyScope] = useState<'NL Material' | 'NP Material'>('NL Material');
    /** Catalog filter: show materials in any selected group (empty = all). */
    const [groupFilterIds, setGroupFilterIds] = useState<string[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const [editOpen, setEditOpen] = useState(false);
    const [editorRow, setEditorRow] = useState<StockMaterialRow | null>(null);
    const [editorLoading, setEditorLoading] = useState(false);
    const [editorSaving, setEditorSaving] = useState(false);
    const [editorError, setEditorError] = useState<string | null>(null);
    const [editorIsCreate, setEditorIsCreate] = useState(false);

    const [stockEditMaterialId, setStockEditMaterialId] = useState<string | null>(null);
    const [stockEditDraft, setStockEditDraft] = useState('');
    const [stockEditSaving, setStockEditSaving] = useState(false);
    const stockEditInputRef = useRef<HTMLInputElement>(null);
    const skipStockBlurCommitRef = useRef(false);

    const [groupEditMaterialId, setGroupEditMaterialId] = useState<string | null>(null);
    const [groupEditDraft, setGroupEditDraft] = useState<string[]>([]);
    const [groupEditSaving, setGroupEditSaving] = useState(false);
    const groupEditTriggerRef = useRef<HTMLButtonElement>(null);
    const skipGroupBlurCommitRef = useRef(false);

    const stockRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

    const [barcodeAmbiguousIds, setBarcodeAmbiguousIds] = useState<string[] | null>(null);

    const [touchQtyId, setTouchQtyId] = useState<string | null>(null);
    const [touchQtyValue, setTouchQtyValue] = useState('');
    const [touchQtySaving, setTouchQtySaving] = useState(false);
    const touchQtyInputRef = useRef<HTMLInputElement>(null);

    type StockTab = 'catalog' | 'takeout' | 'receive' | 'reorder';
    const [stockTab, setStockTab] = useState<StockTab>('catalog');
    const stockTabRef = useRef<StockTab>('catalog');
    useEffect(() => {
        stockTabRef.current = stockTab;
    }, [stockTab]);

    const [movementOpen, setMovementOpen] = useState(false);
    const [movementRow, setMovementRow] = useState<StockMaterialRow | null>(null);
    const [movementKind, setMovementKind] = useState<'issue' | 'receive'>('issue');
    const [movementQtyStr, setMovementQtyStr] = useState('1');
    const [movementSaving, setMovementSaving] = useState(false);
    const [movementError, setMovementError] = useState<string | null>(null);

    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const [deleteSaving, setDeleteSaving] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const [stockNotice, setStockNotice] = useState<string | null>(null);

    const [reorderRows, setReorderRows] = useState<StockReorderCandidateRow[]>([]);
    const [reorderLoading, setReorderLoading] = useState(false);
    const [reorderReloadTick, setReorderReloadTick] = useState(0);
    const [reorderFactor, setReorderFactor] = useState<number>(1);
    const [reorderLineQty, setReorderLineQty] = useState<Record<string, string>>({});
    const [reorderExcluded, setReorderExcluded] = useState<Set<string>>(() => new Set());
    const [reorderExtras, setReorderExtras] = useState<StockReorderCandidateRow[]>([]);
    const [reorderFindQ, setReorderFindQ] = useState('');
    const [reorderFindList, setReorderFindList] = useState<StockMaterialRow[]>([]);
    const [reorderFindBusy, setReorderFindBusy] = useState(false);

    const scanBufferRef = useRef('');
    const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const loadMain = useCallback(
        async (companyForFetch?: 'NL Material' | 'NP Material') => {
            const company = companyForFetch ?? companyScope;
            setLoading(true);
            setError(null);
            try {
                const [m, mat, grpAll] = await Promise.all([
                    fetchStockMeta(),
                    fetchStockMaterials({
                        q,
                        activeOnly,
                        company,
                        ...(groupFilterIds.length > 0 ? { groupIds: groupFilterIds } : {}),
                    }),
                    fetchStockMaterialGroups(),
                ]);
                setMeta(m);
                setMaterials(mat);
                setGroups(grpAll);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to load stock data');
                setMaterials([]);
                setGroups([]);
                setCatalogGroups([]);
            } finally {
                setLoading(false);
            }
        },
        [q, activeOnly, companyScope, groupFilterIds]
    );

    const loadCatalogGroups = useCallback(async () => {
        try {
            const rows = await fetchStockMaterialGroupsForCatalog({ q, activeOnly, company: companyScope });
            setCatalogGroups(rows);
        } catch {
            setCatalogGroups([]);
        }
    }, [q, activeOnly, companyScope]);

    const reloadGroups = useCallback(async () => {
        try {
            const grpAll = await fetchStockMaterialGroups();
            setGroups(grpAll);
            await loadCatalogGroups();
        } catch {
            /* keep existing list */
        }
    }, [loadCatalogGroups]);

    useEffect(() => {
        void loadMain();
    }, [loadMain]);

    useEffect(() => {
        void loadCatalogGroups();
    }, [loadCatalogGroups]);

    useEffect(() => {
        if (loading || !selectedId) return;
        if (!materials.some((r) => r.material_id === selectedId)) {
            setSelectedId(null);
        }
    }, [loading, materials, selectedId]);

    useEffect(() => {
        if (groupFilterIds.length === 0) return;
        const valid = new Set(catalogGroups.map((g) => g.group_id));
        setGroupFilterIds((prev) => prev.filter((id) => valid.has(id)));
    }, [catalogGroups, groupFilterIds.length]);

    useEffect(() => {
        if (!focusMaterialId?.trim()) return;
        const id = focusMaterialId.trim();
        setSelectedId(id);
        if (focusOpenStockMovement === 'issue') {
            let cancelled = false;
            fetchStockMaterialById(id)
                .then((row) => {
                    if (cancelled) return;
                    setMovementRow(row);
                    setMovementKind('issue');
                    setMovementQtyStr('1');
                    setMovementError(null);
                    setMovementOpen(true);
                })
                .catch((e) => {
                    if (!cancelled) {
                        setError(e instanceof Error ? e.message : 'Failed to load material');
                    }
                })
                .finally(() => {
                    if (!cancelled) onFocusConsumed?.();
                });
            return () => {
                cancelled = true;
            };
        }
        return undefined;
    }, [focusMaterialId, focusOpenStockMovement, onFocusConsumed]);

    useEffect(() => {
        if (!selectedId) {
            setPricing([]);
            return;
        }
        let cancelled = false;
        setPricingLoading(true);
        fetchStockSupplierPricing(selectedId)
            .then((rows) => {
                if (!cancelled) setPricing(rows);
            })
            .catch(() => {
                if (!cancelled) setPricing([]);
            })
            .finally(() => {
                if (!cancelled) setPricingLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedId]);

    useEffect(() => {
        if (!selectedId) {
            setMovements([]);
            setMovementsError(null);
            setMovementsHasMore(false);
            return;
        }
        let cancelled = false;
        setMovementsLoading(true);
        setMovementsError(null);
        fetchStockMaterialMovements(selectedId, { limit: MOVEMENT_PAGE_SIZE, offset: 0 })
            .then((res) => {
                if (!cancelled) {
                    setMovements(res.movements);
                    setMovementsHasMore(res.movements.length === MOVEMENT_PAGE_SIZE);
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setMovements([]);
                    setMovementsHasMore(false);
                    setMovementsError(e instanceof Error ? e.message : 'Failed to load movements');
                }
            })
            .finally(() => {
                if (!cancelled) setMovementsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedId, movementHistoryTick]);

    const loadMoreMovements = useCallback(async () => {
        if (!selectedId || movementsLoadingMore) return;
        setMovementsLoadingMore(true);
        setMovementsError(null);
        try {
            const res = await fetchStockMaterialMovements(selectedId, {
                limit: MOVEMENT_PAGE_SIZE,
                offset: movements.length,
            });
            setMovements((prev) => [...prev, ...res.movements]);
            setMovementsHasMore(res.movements.length === MOVEMENT_PAGE_SIZE);
        } catch (e) {
            setMovementsError(e instanceof Error ? e.message : 'Failed to load more');
        } finally {
            setMovementsLoadingMore(false);
        }
    }, [selectedId, movements.length, movementsLoadingMore]);

    const copyMovementsCsv = useCallback(() => {
        if (!selectedId || movements.length === 0) return;
        const header = [
            'created_at',
            'direction',
            'requested_delta',
            'applied_delta',
            'stock_before',
            'stock_after',
            'clamped',
        ];
        const lines = [header.join(',')];
        for (const m of movements) {
            const clamped = movementWasClamped(m) ? 'yes' : '';
            lines.push(
                [
                    csvEscapeCell(m.created_at),
                    csvEscapeCell(movementDirectionLabel(m)),
                    csvEscapeCell(String(m.requested_delta)),
                    csvEscapeCell(String(m.applied_delta)),
                    csvEscapeCell(String(m.stock_before)),
                    csvEscapeCell(String(m.stock_after)),
                    csvEscapeCell(clamped),
                ].join(',')
            );
        }
        void navigator.clipboard.writeText(lines.join('\n'));
        setStockNotice('Copied movement history as CSV.');
    }, [selectedId, movements]);

    const selectedMaterial = useMemo(
        () => materials.find((r) => r.material_id === selectedId) ?? null,
        [materials, selectedId]
    );

    const duplicateSelectedMaterial = useCallback(async () => {
        if (!selectedMaterial) return;
        const code = duplicateMaterialCode(selectedMaterial);
        const body = buildCreateBodyFromRow(selectedMaterial, code);
        body.internal_barcode = null;
        body.vendor_barcode = null;
        body.alternate_barcode = null;

        setError(null);
        try {
            const created = await createStockMaterial(body);
            const catalogCompany: 'NL Material' | 'NP Material' =
                created.company === 'NP Material' ? 'NP Material' : 'NL Material';
            setCompanyScope(catalogCompany);
            if (created.is_active === false) setActiveOnly(false);
            setSelectedId(created.material_id);
            setStockNotice(`Material duplicated as ${code}.`);
            await loadMain(catalogCompany);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Duplicate failed');
        }
    }, [selectedMaterial, loadMain]);

    const mergedReorderLines = useMemo(() => {
        const map = new Map<string, StockReorderCandidateRow>();
        for (const r of reorderRows) {
            if (!reorderExcluded.has(r.material_id)) map.set(r.material_id, r);
        }
        for (const r of reorderExtras) {
            if (!reorderExcluded.has(r.material_id)) map.set(r.material_id, r);
        }
        return [...map.values()].sort((a, b) =>
            String(a.material_name ?? a.material_id).localeCompare(String(b.material_name ?? b.material_id))
        );
    }, [reorderRows, reorderExtras, reorderExcluded]);

    const openMovementFromSelection = useCallback(
        (kind: 'issue' | 'receive') => {
            const m = materials.find((r) => r.material_id === selectedId);
            if (!m) return;
            setMovementRow(m);
            setMovementKind(kind);
            setMovementQtyStr(kind === 'issue' ? '1' : '');
            setMovementError(null);
            setMovementOpen(true);
        },
        [materials, selectedId]
    );

    const closeMovement = useCallback(() => {
        setMovementOpen(false);
        setMovementRow(null);
        setMovementError(null);
    }, []);

    const deleteTargetMaterial = useMemo(
        () => (deleteTargetId ? materials.find((r) => r.material_id === deleteTargetId) ?? null : null),
        [materials, deleteTargetId]
    );

    const openDeleteModal = useCallback(() => {
        if (!selectedId) return;
        setDeleteTargetId(selectedId);
        setDeleteError(null);
        setDeleteModalOpen(true);
    }, [selectedId]);

    const closeDeleteModal = useCallback(() => {
        setDeleteModalOpen(false);
        setDeleteTargetId(null);
        setDeleteError(null);
    }, []);

    const confirmDeleteMaterial = useCallback(async () => {
        if (!deleteTargetId) return;
        setDeleteSaving(true);
        setDeleteError(null);
        try {
            await deleteStockMaterial(deleteTargetId);
            const removedId = deleteTargetId;
            setDeleteModalOpen(false);
            setDeleteTargetId(null);
            if (selectedId === removedId) setSelectedId(null);
            if (editorRow?.material_id === removedId) {
                setEditOpen(false);
                setEditorRow(null);
                setEditorError(null);
            }
            if (stockEditMaterialId === removedId) {
                setStockEditMaterialId(null);
                setStockEditDraft('');
            }
            if (groupEditMaterialId === removedId) {
                setGroupEditMaterialId(null);
                setGroupEditDraft([]);
            }
            if (movementRow?.material_id === removedId) closeMovement();
            setStockNotice('Material deleted from the catalog.');
            await loadMain();
        } catch (e) {
            setDeleteError(e instanceof Error ? e.message : 'Delete failed');
        } finally {
            setDeleteSaving(false);
        }
    }, [
        deleteTargetId,
        selectedId,
        editorRow?.material_id,
        stockEditMaterialId,
        groupEditMaterialId,
        movementRow?.material_id,
        closeMovement,
        loadMain,
    ]);

    const confirmMovement = useCallback(async () => {
        if (!movementRow) return;
        const qty = parseFloat(movementQtyStr.trim());
        if (!Number.isFinite(qty) || qty <= 0) {
            setMovementError('Enter a positive quantity.');
            return;
        }
        setMovementSaving(true);
        setMovementError(null);
        try {
            const delta = movementKind === 'issue' ? -qty : qty;
            const res = await adjustStockMaterial(movementRow.material_id, delta);
            setStockNotice(
                res.clamped
                    ? `Stock updated. Requested to remove ${qty} but only ${Math.abs(res.applied_delta)} could be removed (stock is now 0).`
                    : movementKind === 'issue'
                      ? `Removed ${Math.abs(res.applied_delta)} from ${movementRow.material_name ?? movementRow.material_id}.`
                      : `Added ${res.applied_delta} to ${movementRow.material_name ?? movementRow.material_id}.`
            );
            setMovementOpen(false);
            setMovementRow(null);
            await loadMain();
            setMovementHistoryTick((t) => t + 1);
        } catch (e) {
            setMovementError(e instanceof Error ? e.message : 'Adjust failed');
        } finally {
            setMovementSaving(false);
        }
    }, [movementRow, movementQtyStr, movementKind, loadMain]);

    useEffect(() => {
        if (stockTab !== 'reorder') return;
        let cancelled = false;
        setReorderLoading(true);
        setError(null);
        fetchStockReorderCandidates({ company: companyScope, activeOnly, targetFactor: reorderFactor })
            .then((rows) => {
                if (!cancelled) {
                    setReorderRows(rows);
                    setReorderLineQty({});
                    setReorderExcluded(new Set());
                    setReorderExtras([]);
                    setReorderFindList([]);
                }
            })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load reorder list');
            })
            .finally(() => {
                if (!cancelled) setReorderLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [stockTab, companyScope, activeOnly, reorderFactor, reorderReloadTick]);

    useEffect(() => {
        if (stockTab !== 'reorder') return;
        setReorderExtras((prev) =>
            prev.map((r) => {
                const next = rowToReorderCandidate(r, reorderFactor);
                return { ...r, ...next, supplier_minimum_order_quantity: r.supplier_minimum_order_quantity, supplier_cost_per_unit: r.supplier_cost_per_unit };
            })
        );
    }, [reorderFactor, stockTab]);

    useEffect(() => {
        if (!stockNotice) return;
        const t = setTimeout(() => setStockNotice(null), 6000);
        return () => clearTimeout(t);
    }, [stockNotice]);

    const runReorderFind = useCallback(async () => {
        const t = reorderFindQ.trim();
        if (!t) {
            setReorderFindList([]);
            return;
        }
        setReorderFindBusy(true);
        try {
            const rows = await fetchStockMaterials({ q: t, activeOnly: false, company: companyScope });
            setReorderFindList(rows.slice(0, 25));
        } catch {
            setReorderFindList([]);
        } finally {
            setReorderFindBusy(false);
        }
    }, [reorderFindQ, companyScope]);

    const copyReorderTsv = useCallback(() => {
        const lines = ['material_id\tname\tqty\tunit'];
        for (const r of mergedReorderLines) {
            const id = r.material_id;
            const raw = reorderLineQty[id];
            const qtyCell = raw != null && raw.trim() !== '' ? raw : String(r.suggested_order_qty ?? '');
            lines.push([id, r.material_name ?? '', qtyCell, r.pricing_unit ?? ''].join('\t'));
        }
        void navigator.clipboard.writeText(lines.join('\n'));
        setStockNotice('Copied reorder lines as TSV.');
    }, [mergedReorderLines, reorderLineQty]);

    const addReorderExtra = useCallback(
        (row: StockMaterialRow) => {
            setReorderExtras((prev) => {
                if (prev.some((p) => p.material_id === row.material_id)) return prev;
                return [...prev, rowToReorderCandidate(row, reorderFactor)];
            });
            setReorderExcluded((prev) => {
                const next = new Set(prev);
                next.delete(row.material_id);
                return next;
            });
            setReorderFindList([]);
            setReorderFindQ('');
        },
        [reorderFactor]
    );

    useEffect(() => {
        if (isTouch) return;
        const tab = stockTabRef.current;
        if (tab !== 'takeout' && tab !== 'receive') return;

        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const isInputElement =
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable ||
                target.tagName === 'SELECT';

            if (isInputElement) {
                scanBufferRef.current = '';
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                    scanTimeoutRef.current = null;
                }
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const bufferedValue = scanBufferRef.current.trim();
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                    scanTimeoutRef.current = null;
                }
                scanBufferRef.current = '';
                if (!bufferedValue) return;
                void (async () => {
                    try {
                        const lookup = await fetchStockMaterialByBarcode(bufferedValue);
                        if (lookup.status === 'ok') {
                            const m = lookup.material;
                            setCompanyScope(m.company === 'NP Material' ? 'NP Material' : 'NL Material');
                            setActiveOnly((prev) => (m.is_active === false ? false : prev));
                            setQ('');
                            setSelectedId(m.material_id);
                            setBarcodeAmbiguousIds(null);
                            setError(null);
                            const kind = stockTabRef.current === 'takeout' ? 'issue' : 'receive';
                            setMovementRow(m);
                            setMovementKind(kind);
                            setMovementQtyStr(kind === 'issue' ? '1' : '');
                            setMovementError(null);
                            setMovementOpen(true);
                        } else if (lookup.status === 'ambiguous') {
                            setBarcodeAmbiguousIds(lookup.materialIds);
                        } else if (lookup.status === 'not_found') {
                            setError(`No material for barcode: ${bufferedValue}`);
                        } else {
                            setError(lookup.message);
                        }
                    } catch (err) {
                        setError(err instanceof Error ? err.message : 'Barcode lookup failed');
                    }
                })();
                return;
            }

            if (
                e.key === '_' ||
                (e.key.length === 1 &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.altKey &&
                    (e.key.match(/[a-zA-Z0-9_\-]/) || (e.key === '-' && e.shiftKey)))
            ) {
                if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
                const charToAdd = e.key === '-' && e.shiftKey ? '_' : e.key;
                scanBufferRef.current += charToAdd;
                scanTimeoutRef.current = setTimeout(() => {
                    scanBufferRef.current = '';
                }, 500);
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
                if (scanBufferRef.current.length > 0) {
                    scanBufferRef.current = scanBufferRef.current.slice(0, -1);
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown, true);
            if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
        };
    }, [stockTab, isTouch]);

    const touchQtyMaterial = useMemo(
        () => (touchQtyId ? materials.find((m) => m.material_id === touchQtyId) ?? null : null),
        [touchQtyId, materials]
    );

    const openTouchQty = useCallback((row: StockMaterialRow) => {
        setTouchQtyId(row.material_id);
        setTouchQtyValue(strVal(row.stock));
        setError(null);
    }, []);

    const closeTouchQty = useCallback(() => {
        setTouchQtyId(null);
        setTouchQtyValue('');
    }, []);

    const adjustTouchQty = useCallback((delta: number) => {
        setTouchQtyValue((prev) => {
            const n = Number(prev.trim());
            const base = Number.isFinite(n) ? n : 0;
            const next = Math.max(0, base + delta);
            return String(next);
        });
    }, []);

    const confirmTouchQty = useCallback(async () => {
        if (!touchQtyId) return;
        const trimmed = touchQtyValue.trim();
        let stockVal: number | null;
        if (trimmed === '') {
            stockVal = null;
        } else {
            const n = Number(trimmed);
            if (!Number.isFinite(n)) {
                setError('Enter a valid quantity.');
                touchQtyInputRef.current?.focus();
                return;
            }
            stockVal = n;
        }
        setTouchQtySaving(true);
        setError(null);
        try {
            await updateStockMaterial(touchQtyId, { stock: stockVal });
            closeTouchQty();
            await loadMain();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update stock');
        } finally {
            setTouchQtySaving(false);
        }
    }, [touchQtyId, touchQtyValue, closeTouchQty, loadMain]);

    const openEditorWithId = useCallback(async (materialId: string) => {
        setEditorIsCreate(false);
        setSelectedId(materialId);
        setEditOpen(true);
        setEditorLoading(true);
        setEditorError(null);
        try {
            const row = await fetchStockMaterialById(materialId);
            setEditorRow(row);
        } catch (e) {
            setEditorError(e instanceof Error ? e.message : 'Failed to load material');
            setEditorRow(null);
        } finally {
            setEditorLoading(false);
        }
    }, []);

    const openEditor = useCallback(async () => {
        if (!selectedId) return;
        await openEditorWithId(selectedId);
    }, [selectedId, openEditorWithId]);

    const openCreateMaterial = useCallback(() => {
        setEditorIsCreate(true);
        setEditOpen(true);
        setEditorLoading(false);
        setEditorError(null);
        setEditorRow(emptyMaterialDraft(companyScope));
    }, [companyScope]);

    const closeEditor = useCallback(() => {
        setEditOpen(false);
        setEditorRow(null);
        setEditorError(null);
        setEditorIsCreate(false);
    }, []);

    const saveEditor = useCallback(async () => {
        if (!editorRow) return;

        if (editorIsCreate) {
            const code = String(editorRow.material_code ?? '').trim();
            if (!code) {
                setEditorError('Material code is required.');
                return;
            }
            setEditorSaving(true);
            setEditorError(null);
            try {
                const body = buildCreateBodyFromRow(editorRow, code);
                const created = await createStockMaterial(body);
                const catalogCompany: 'NL Material' | 'NP Material' =
                    created.company === 'NP Material' ? 'NP Material' : 'NL Material';
                setCompanyScope(catalogCompany);
                if (created.is_active === false) setActiveOnly(false);
                setSelectedId(created.material_id);
                setStockNotice('Material created.');
                await loadMain(catalogCompany);
                closeEditor();
            } catch (e) {
                setEditorError(e instanceof Error ? e.message : 'Create failed');
            } finally {
                setEditorSaving(false);
            }
            return;
        }

        if (!editorRow.material_id) return;
        setEditorSaving(true);
        setEditorError(null);
        try {
            const patch: StockMaterialPatch = {
                stock:
                    editorRow.stock === '' || editorRow.stock == null
                        ? null
                        : Number(editorRow.stock),
                reorder_level:
                    editorRow.reorder_level === '' || editorRow.reorder_level == null
                        ? null
                        : Number(editorRow.reorder_level),
                internal_barcode: editorRow.internal_barcode,
                vendor_barcode: editorRow.vendor_barcode,
                alternate_barcode: editorRow.alternate_barcode,
                location: editorRow.location,
                material_code: editorRow.material_code,
                material_name: editorRow.material_name,
                substrate_type: editorRow.substrate_type,
                adhesive_type: editorRow.adhesive_type,
                handling: editorRow.handling,
                coating: editorRow.coating,
                grain_direction: editorRow.grain_direction,
                glossy_level: editorRow.glossy_level,
                weight_gsm: editorRow.weight_gsm,
                width_mm:
                    editorRow.width_mm === '' || editorRow.width_mm == null
                        ? null
                        : Number(editorRow.width_mm),
                length_mm:
                    editorRow.length_mm === '' || editorRow.length_mm == null
                        ? null
                        : Number(editorRow.length_mm),
                cost_aud:
                    editorRow.cost_aud === '' || editorRow.cost_aud == null
                        ? null
                        : Number(editorRow.cost_aud),
                pricing_unit: editorRow.pricing_unit,
                substrate_groups: groupIdsFromRow(editorRow),
                lead_time_days: editorRow.lead_time_days,
                aliases: editorRow.aliases,
                conductive: editorRow.conductive,
                white_material: editorRow.white_material,
                is_active: editorRow.is_active,
            };
            await updateStockMaterial(editorRow.material_id, patch);
            await loadMain();
            closeEditor();
        } catch (e) {
            setEditorError(e instanceof Error ? e.message : 'Save failed');
        } finally {
            setEditorSaving(false);
        }
    }, [editorRow, editorIsCreate, loadMain, closeEditor]);

    const setEditorField = useCallback(<K extends keyof StockMaterialRow>(key: K, value: StockMaterialRow[K]) => {
        setEditorRow((prev) => (prev ? { ...prev, [key]: value } : prev));
    }, []);

    useEffect(() => {
        if (!stockEditMaterialId) return;
        const el = stockEditInputRef.current;
        if (!el) return;
        el.focus();
        el.select();
    }, [stockEditMaterialId]);

    const applyMaterialFromBarcode = useCallback(
        (material: StockMaterialRow) => {
            setCompanyScope(material.company === 'NP Material' ? 'NP Material' : 'NL Material');
            setActiveOnly((prev) => (material.is_active === false ? false : prev));
            setQ('');
            setSelectedId(material.material_id);
            setBarcodeAmbiguousIds(null);
            setError(null);
            const tab = stockTabRef.current;
            if (tab === 'takeout' || tab === 'receive') {
                const kind = tab === 'takeout' ? 'issue' : 'receive';
                setMovementRow(material);
                setMovementKind(kind);
                setMovementQtyStr(kind === 'issue' ? '1' : '');
                setMovementError(null);
                setMovementOpen(true);
                return;
            }
            setStockEditMaterialId(material.material_id);
            setStockEditDraft(strVal(material.stock));
        },
        []
    );

    const resolveAmbiguousPick = useCallback(
        async (materialId: string) => {
            setBarcodeAmbiguousIds(null);
            try {
                const row = await fetchStockMaterialById(materialId);
                applyMaterialFromBarcode(row);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to load material');
            }
        },
        [applyMaterialFromBarcode]
    );

    const cancelStockEdit = useCallback(() => {
        setStockEditMaterialId(null);
        setStockEditDraft('');
    }, []);

    const cancelGroupEdit = useCallback(() => {
        setGroupEditMaterialId(null);
        setGroupEditDraft([]);
    }, []);

    const startGroupEdit = useCallback(
        (row: StockMaterialRow) => {
            cancelStockEdit();
            setGroupEditMaterialId(row.material_id);
            setGroupEditDraft(groupIdsFromRow(row));
            setError(null);
        },
        [cancelStockEdit]
    );

    const toggleGroupFilter = useCallback((groupId: string) => {
        setGroupFilterIds((prev) =>
            prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId]
        );
    }, []);

    useEffect(() => {
        if (!selectedId) return;
        const el = stockRowRefs.current.get(selectedId);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedId, materials]);

    const commitGroupEditWithDraft = useCallback(
        async (draft: string[]) => {
            if (skipGroupBlurCommitRef.current) {
                skipGroupBlurCommitRef.current = false;
                return;
            }
            if (!groupEditMaterialId) return;
            const row = materials.find((m) => m.material_id === groupEditMaterialId);
            const current = row ? groupIdsFromRow(row) : [];
            if (sameGroupIdSet(current, draft)) {
                cancelGroupEdit();
                return;
            }
            setGroupEditSaving(true);
            setError(null);
            try {
                await updateStockMaterial(groupEditMaterialId, { substrate_groups: draft });
                cancelGroupEdit();
                await loadMain();
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to update substrate groups');
                groupEditTriggerRef.current?.focus();
            } finally {
                setGroupEditSaving(false);
            }
        },
        [groupEditMaterialId, materials, cancelGroupEdit, loadMain]
    );

    const commitStockEdit = useCallback(async () => {
        if (skipStockBlurCommitRef.current) {
            skipStockBlurCommitRef.current = false;
            return;
        }
        if (!stockEditMaterialId) return;
        const trimmed = stockEditDraft.trim();
        let stockVal: number | null;
        if (trimmed === '') {
            stockVal = null;
        } else {
            const n = Number(trimmed);
            if (!Number.isFinite(n)) {
                setError('Enter a valid number for stock quantity.');
                stockEditInputRef.current?.focus();
                return;
            }
            stockVal = n;
        }
        setStockEditSaving(true);
        setError(null);
        try {
            await updateStockMaterial(stockEditMaterialId, { stock: stockVal });
            setStockEditMaterialId(null);
            setStockEditDraft('');
            await loadMain();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update stock');
        } finally {
            setStockEditSaving(false);
        }
    }, [stockEditMaterialId, stockEditDraft, loadMain]);

    const movementPreview = useMemo(() => {
        if (!movementRow) return { current: 0, next: 0, wouldClamp: false };
        const current = numOr0(movementRow.stock);
        const qty = parseFloat(movementQtyStr.trim());
        if (!Number.isFinite(qty) || qty <= 0) return { current, next: current, wouldClamp: false };
        if (movementKind === 'issue') {
            const next = Math.max(0, current - qty);
            return { current, next, wouldClamp: qty > current };
        }
        return { current, next: current + qty, wouldClamp: false };
    }, [movementRow, movementQtyStr, movementKind]);

    useEffect(() => {
        if (isTouch && stockTab !== 'catalog') setStockTab('catalog');
    }, [isTouch, stockTab]);

    return (
        <div className={`stock-page${isTouch ? ' stock-page--touch' : ''}`}>
            <header className={`stock-header${isTouch ? ' stock-header--touch' : ''}`}>
                {isTouch ? (
                    <div className="stock-touch-top">
                            <div className="stock-company-toggle" role="group" aria-label="Material catalog">
                                <button
                                    type="button"
                                    className={companyScope === 'NL Material' ? 'is-active' : ''}
                                    onClick={() => setCompanyScope('NL Material')}
                                >
                                    NL
                                </button>
                                <button
                                    type="button"
                                    className={companyScope === 'NP Material' ? 'is-active' : ''}
                                    onClick={() => setCompanyScope('NP Material')}
                                >
                                    NP
                                </button>
                            </div>
                            <div
                                className="stock-touch-group-filters"
                                role="group"
                                aria-label="Filter by group"
                            >
                            <button
                                type="button"
                                className={`stock-touch-group-btn${groupFilterIds.length === 0 ? ' is-active' : ''}`}
                                aria-pressed={groupFilterIds.length === 0}
                                onClick={() => setGroupFilterIds([])}
                            >
                                All groups
                            </button>
                            {catalogGroups.map((g) => {
                                const active = groupFilterIds.includes(g.group_id);
                                return (
                                    <button
                                        key={g.group_id}
                                        type="button"
                                        className={`stock-touch-group-btn${active ? ' is-active' : ''}`}
                                        aria-pressed={active}
                                        onClick={() => toggleGroupFilter(g.group_id)}
                                    >
                                        {g.group_color ? (
                                            <span
                                                className="stock-group-dot"
                                                style={{ backgroundColor: g.group_color }}
                                                aria-hidden
                                            />
                                        ) : (
                                            <span className="stock-group-dot" style={{ opacity: 0.3 }} aria-hidden />
                                        )}
                                        {g.group_name}
                                    </button>
                                );
                            })}
                            </div>
                            <input
                                type="search"
                                className="stock-search stock-search--touch"
                                placeholder="Search materials…"
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                                aria-label="Filter materials"
                            />
                    </div>
                ) : (
                    <>
                {meta && !meta.jobmanagerUrlConfigured ? (
                    <p className="stock-hint">
                        <strong>Note:</strong> A separate jobmanager database URL is not configured — stock uses the
                        same database as the app. If your materials live only on jobmanager, set that connection in
                        your environment.
                    </p>
                ) : null}
                <div className="stock-controls">
                    <div className="stock-company-toggle" role="group" aria-label="Material catalog">
                        <button
                            type="button"
                            className={companyScope === 'NL Material' ? 'is-active' : ''}
                            onClick={() => setCompanyScope('NL Material')}
                        >
                            NL
                        </button>
                        <button
                            type="button"
                            className={companyScope === 'NP Material' ? 'is-active' : ''}
                            onClick={() => setCompanyScope('NP Material')}
                        >
                            NP
                        </button>
                    </div>
                    <input
                        type="search"
                        className="stock-search"
                        placeholder="Search name, id, aliases, barcodes…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        aria-label="Filter materials"
                    />
                    <label className="stock-toggle">
                        <input
                            type="checkbox"
                            checked={activeOnly}
                            onChange={(e) => setActiveOnly(e.target.checked)}
                        />
                        Active only
                    </label>
                    <button type="button" className="stock-edit-btn" onClick={openCreateMaterial}>
                        <Plus size={16} aria-hidden />
                        Add material…
                    </button>
                    <button
                        type="button"
                        className="stock-edit-btn"
                        disabled={!selectedMaterial}
                        onClick={() => void duplicateSelectedMaterial()}
                    >
                        <ClipboardCopy size={16} aria-hidden />
                        Duplicate selected
                    </button>
                    <button
                        type="button"
                        className="stock-edit-btn"
                        disabled={!selectedId}
                        onClick={() => openMovementFromSelection('issue')}
                    >
                        <MinusCircle size={16} aria-hidden />
                        Take out…
                    </button>
                    <button
                        type="button"
                        className="stock-edit-btn"
                        disabled={!selectedId}
                        onClick={() => openMovementFromSelection('receive')}
                    >
                        <PlusCircle size={16} aria-hidden />
                        Receive…
                    </button>
                    <button
                        type="button"
                        className="stock-edit-btn"
                        disabled={!selectedId}
                        onClick={() => void openEditor()}
                    >
                        <Pencil size={16} aria-hidden />
                        Edit selected
                    </button>
                    <button
                        type="button"
                        className="stock-edit-btn stock-edit-btn--danger"
                        disabled={!selectedId}
                        onClick={openDeleteModal}
                    >
                        <Trash2 size={16} aria-hidden />
                        Delete selected…
                    </button>
                </div>
                    </>
                )}
            </header>

            {stockNotice ? <div className="stock-notice">{stockNotice}</div> : null}
            {error ? <div className="stock-error">{error}</div> : null}
            {!isTouch && barcodeAmbiguousIds && barcodeAmbiguousIds.length > 0 ? (
                <div className="stock-ambiguous" role="group" aria-label="Pick material">
                    <span className="stock-muted">Ambiguous barcode — pick material:</span>
                    {barcodeAmbiguousIds.map((id) => (
                        <button key={id} type="button" className="stock-edit-btn" onClick={() => void resolveAmbiguousPick(id)}>
                            {id}
                        </button>
                    ))}
                    <button type="button" className="stock-btn-secondary" onClick={() => setBarcodeAmbiguousIds(null)}>
                        Cancel
                    </button>
                </div>
            ) : null}

            {stockTab === 'reorder' ? (
                <div className="stock-reorder">
                    <div className="stock-reorder-toolbar">
                        <span className="stock-muted">Target × reorder level:</span>
                        {[1, 1.5, 2].map((f) => (
                            <button
                                key={f}
                                type="button"
                                className={reorderFactor === f ? 'stock-edit-btn is-active' : 'stock-edit-btn'}
                                onClick={() => setReorderFactor(f)}
                            >
                                {f}×
                            </button>
                        ))}
                        <button
                            type="button"
                            className="stock-edit-btn"
                            disabled={reorderLoading}
                            onClick={() => setReorderReloadTick((t) => t + 1)}
                        >
                            Refresh
                        </button>
                        <button
                            type="button"
                            className="stock-edit-btn"
                            disabled={mergedReorderLines.length === 0}
                            onClick={() => void copyReorderTsv()}
                        >
                            <ClipboardCopy size={16} aria-hidden />
                            Copy TSV
                        </button>
                    </div>
                    <div className="stock-reorder-add">
                        <input
                            type="search"
                            className="stock-search"
                            placeholder="Find material to add…"
                            value={reorderFindQ}
                            onChange={(e) => setReorderFindQ(e.target.value)}
                            aria-label="Find material for reorder list"
                        />
                        <button type="button" className="stock-edit-btn" disabled={reorderFindBusy} onClick={() => void runReorderFind()}>
                            {reorderFindBusy ? 'Searching…' : 'Search'}
                        </button>
                    </div>
                    {reorderFindList.length > 0 ? (
                        <ul className="stock-reorder-find">
                            {reorderFindList.map((r) => (
                                <li key={r.material_id}>
                                    <button type="button" className="stock-reorder-find-btn" onClick={() => addReorderExtra(r)}>
                                        Add {r.material_name ?? r.material_id}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <div className="stock-table-wrap stock-reorder-table-wrap">
                        {reorderLoading ? (
                            <p className="stock-muted" style={{ padding: '1.5rem' }}>
                                Loading reorder list…
                            </p>
                        ) : mergedReorderLines.length === 0 ? (
                            <p className="stock-muted" style={{ padding: '1.5rem' }}>
                                No low-stock materials for this company filter. Add lines with Search, or adjust target
                                multiplier.
                            </p>
                        ) : (
                            <table className="stock-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Stock</th>
                                        <th>Reorder</th>
                                        <th>Suggested</th>
                                        <th>Order qty</th>
                                        <th>MOQ</th>
                                        <th>Unit</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {mergedReorderLines.map((r) => {
                                        const id = r.material_id;
                                        const defQty = String(r.suggested_order_qty ?? '');
                                        const qtyVal = reorderLineQty[id] ?? defQty;
                                        return (
                                            <tr key={id}>
                                                <td>{r.material_name ?? '—'}</td>
                                                <td className="stock-num">{formatNum(r.stock)}</td>
                                                <td className="stock-num">{formatNum(r.reorder_level)}</td>
                                                <td className="stock-num">{formatNum(r.suggested_order_qty)}</td>
                                                <td>
                                                    <input
                                                        type="text"
                                                        inputMode="decimal"
                                                        className="stock-inline-qty"
                                                        value={qtyVal}
                                                        aria-label={`Order qty for ${id}`}
                                                        onChange={(e) =>
                                                            setReorderLineQty((prev) => ({ ...prev, [id]: e.target.value }))
                                                        }
                                                    />
                                                </td>
                                                <td className="stock-num">{formatNum(r.supplier_minimum_order_quantity)}</td>
                                                <td>{r.pricing_unit ?? '—'}</td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        className="stock-btn-secondary"
                                                        onClick={() =>
                                                            setReorderExcluded((prev) => new Set(prev).add(id))
                                                        }
                                                    >
                                                        Remove
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            ) : (
            <div className="stock-body">
                <div className="stock-table-wrap">
                    <table className="stock-table">
                        <thead>
                            <tr>
                                <th>Status</th>
                                <th>Co.</th>
                                <th>Name</th>
                                <th>Location</th>
                                <th>Group</th>
                                <th>Stock</th>
                                <th>Reorder</th>
                                <th>Unit</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr>
                                    <td colSpan={9} className="stock-muted" style={{ padding: '1.5rem' }}>
                                        Loading…
                                    </td>
                                </tr>
                            ) : materials.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="stock-muted" style={{ padding: '1.5rem' }}>
                                        No materials match your filters.
                                    </td>
                                </tr>
                            ) : (
                                materials.map((row) => {
                                    const low = Boolean(row.low_stock);
                                    const inactive = row.is_active === false;
                                    const sel = row.material_id === selectedId;
                                    return (
                                        <tr
                                            key={row.material_id}
                                            ref={(el) => {
                                                if (el) {
                                                    stockRowRefs.current.set(row.material_id, el);
                                                } else {
                                                    stockRowRefs.current.delete(row.material_id);
                                                }
                                            }}
                                            className={`${sel ? 'selected' : ''} ${inactive ? 'inactive' : ''}`}
                                            onClick={() => {
                                                if (isTouch) {
                                                    openTouchQty(row);
                                                    return;
                                                }
                                                const togglingOff = selectedId === row.material_id;
                                                if (togglingOff || (selectedId != null && selectedId !== row.material_id)) {
                                                    cancelStockEdit();
                                                    cancelGroupEdit();
                                                }
                                                setSelectedId(togglingOff ? null : row.material_id);
                                            }}
                                            onDoubleClick={() => {
                                                if (isTouch) return;
                                                void openEditorWithId(row.material_id);
                                            }}
                                        >
                                            <td>
                                                <span
                                                    className={`stock-badge ${low ? 'stock-badge--low' : 'stock-badge--ok'}`}
                                                >
                                                    {low ? 'Low' : 'OK'}
                                                </span>
                                            </td>
                                            <td>
                                                <span
                                                    className={`stock-company-badge ${
                                                        (row.company ?? 'NL Material') === 'NP Material'
                                                            ? 'stock-company-badge--np'
                                                            : 'stock-company-badge--nl'
                                                    }`}
                                                    title={row.company ?? 'NL Material'}
                                                >
                                                    {(row.company ?? 'NL Material') === 'NP Material'
                                                        ? 'NP'
                                                        : 'NL'}
                                                </span>
                                            </td>
                                            <td>{row.material_name ?? '—'}</td>
                                            <td title={row.location?.trim() || undefined}>
                                                {row.location?.trim() || '—'}
                                            </td>
                                            <td className="stock-group-cell">
                                                {groupEditMaterialId === row.material_id ? (
                                                    <SubstrateGroupPicker
                                                        groups={groups}
                                                        value={groupEditDraft}
                                                        disabled={groupEditSaving}
                                                        defaultOpen
                                                        commitOnClose
                                                        selectRef={groupEditTriggerRef}
                                                        onGroupsChanged={reloadGroups}
                                                        onChange={setGroupEditDraft}
                                                        onClose={(draft) => void commitGroupEditWithDraft(draft)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Escape') {
                                                                e.preventDefault();
                                                                skipGroupBlurCommitRef.current = true;
                                                                cancelGroupEdit();
                                                            }
                                                        }}
                                                        onClick={(ev) => ev.stopPropagation()}
                                                    />
                                                ) : materialGroupRefs(row).length > 0 ? (
                                                    <div className="stock-group-pills">
                                                        {materialGroupRefs(row).map((g) => (
                                                            <button
                                                                key={g.group_id}
                                                                type="button"
                                                                className={`stock-group-pill stock-group-pill--btn ${
                                                                    groupFilterIds.includes(g.group_id)
                                                                        ? 'is-active'
                                                                        : ''
                                                                }`}
                                                                title="Click to edit groups (⌥/Alt-click to filter)"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (e.altKey) {
                                                                        toggleGroupFilter(g.group_id);
                                                                        return;
                                                                    }
                                                                    startGroupEdit(row);
                                                                }}
                                                            >
                                                                {g.group_color ? (
                                                                    <span
                                                                        className="stock-group-dot"
                                                                        style={{
                                                                            backgroundColor: g.group_color,
                                                                        }}
                                                                        aria-hidden
                                                                    />
                                                                ) : null}
                                                                {g.group_name}
                                                            </button>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="stock-group-set-btn"
                                                        title="Click to set substrate groups"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            startGroupEdit(row);
                                                        }}
                                                    >
                                                        —
                                                    </button>
                                                )}
                                            </td>
                                            <td className="stock-num stock-stock-cell">
                                                {stockEditMaterialId === row.material_id ? (
                                                    <input
                                                        ref={stockEditInputRef}
                                                        type="text"
                                                        inputMode="decimal"
                                                        className="stock-inline-qty"
                                                        value={stockEditDraft}
                                                        disabled={stockEditSaving}
                                                        aria-label="Edit stock quantity"
                                                        onChange={(e) => setStockEditDraft(e.target.value)}
                                                        onBlur={() => void commitStockEdit()}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                void commitStockEdit();
                                                            }
                                                            if (e.key === 'Escape') {
                                                                e.preventDefault();
                                                                skipStockBlurCommitRef.current = true;
                                                                cancelStockEdit();
                                                            }
                                                        }}
                                                        onClick={(ev) => ev.stopPropagation()}
                                                    />
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="stock-qty-btn"
                                                        title="Click to edit quantity"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            cancelGroupEdit();
                                                            setSelectedId(row.material_id);
                                                            setStockEditMaterialId(row.material_id);
                                                            setStockEditDraft(strVal(row.stock));
                                                            setError(null);
                                                        }}
                                                    >
                                                        {formatNum(row.stock)}
                                                    </button>
                                                )}
                                            </td>
                                            <td className="stock-num">{formatNum(row.reorder_level)}</td>
                                            <td>{row.pricing_unit ?? '—'}</td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {!isTouch ? (
                <aside className={`stock-side${selectedId ? ' stock-side--open' : ''}`}>
                    <div className="stock-panel">
                        <h3>Material groups</h3>
                        {groupFilterIds.length > 0 ? (
                            <button
                                type="button"
                                className="stock-link-btn"
                                style={{ marginBottom: 8 }}
                                onClick={() => setGroupFilterIds([])}
                            >
                                Clear group filters ({groupFilterIds.length})
                            </button>
                        ) : null}
                        <div className="stock-groups">
                            {catalogGroups.length === 0 ? (
                                <p className="stock-muted">
                                    No groups in materials for this company, search, and active filter.
                                </p>
                            ) : (
                                catalogGroups.map((g) => (
                                    <button
                                        key={g.group_id}
                                        type="button"
                                        className={`stock-group-row stock-group-row--filter ${
                                            groupFilterIds.includes(g.group_id) ? 'is-active' : ''
                                        }`}
                                        title="Filter catalog (multi-select — click to toggle)"
                                        onClick={() => toggleGroupFilter(g.group_id)}
                                    >
                                        {g.group_color ? (
                                            <span
                                                className="stock-group-dot"
                                                style={{ backgroundColor: g.group_color }}
                                                aria-hidden
                                            />
                                        ) : (
                                            <span className="stock-group-dot" style={{ opacity: 0.3 }} aria-hidden />
                                        )}
                                        <div className="stock-group-row-text">
                                            <div className="stock-group-row-heading">
                                                <strong>{g.group_name}</strong>
                                                {g.material_count != null ? (
                                                    <span className="stock-group-count">{g.material_count}</span>
                                                ) : null}
                                            </div>
                                            {g.group_description ? (
                                                <div style={{ marginTop: 2 }}>{g.group_description}</div>
                                            ) : null}
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="stock-panel">
                        <h3>Supplier pricing</h3>
                        {!selectedMaterial ? (
                            <p className="stock-muted">Select a material row to load supplier prices.</p>
                        ) : (
                            <>
                                <p className="stock-muted" style={{ marginBottom: 8 }}>
                                    {selectedMaterial.material_name ?? selectedMaterial.material_id}
                                </p>
                                {pricingLoading ? (
                                    <p className="stock-muted">Loading…</p>
                                ) : pricing.length === 0 ? (
                                    <p className="stock-muted">No pricing rows for this material.</p>
                                ) : (
                                    <ul className="stock-pricing-list">
                                        {pricing.map((p) => (
                                            <li key={p.pricing_id} className="stock-pricing-item">
                                                <div>
                                                    <strong>{p.supplier_id ?? '—'}</strong>{' '}
                                                    {p.is_active === false ? (
                                                        <span className="stock-muted">(inactive)</span>
                                                    ) : null}
                                                </div>
                                                <div>
                                                    <span className="stock-num">
                                                        {formatNum(p.cost_per_unit)}
                                                    </span>{' '}
                                                    / {p.pricing_unit ?? '—'}
                                                    {p.is_preferred_supplier ? (
                                                        <span className="stock-muted"> · preferred</span>
                                                    ) : null}
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </>
                        )}
                    </div>

                    <div className="stock-panel">
                        <h3>Movement history</h3>
                        {!selectedMaterial ? (
                            <p className="stock-muted">Select a material row to view receive / take-out history.</p>
                        ) : (
                            <>
                                <p className="stock-muted" style={{ marginBottom: 8 }}>
                                    Logged when you confirm Receive or Take out (not catalog stock edits).
                                </p>
                                {movementsLoading ? (
                                    <p className="stock-muted">Loading…</p>
                                ) : movementsError ? (
                                    <div className="stock-error">{movementsError}</div>
                                ) : movements.length === 0 ? (
                                    <p className="stock-muted">No movements yet for this material.</p>
                                ) : (
                                    <>
                                        <div className="stock-movements-toolbar">
                                            <button
                                                type="button"
                                                className="stock-edit-btn"
                                                onClick={() => void copyMovementsCsv()}
                                                aria-label="Copy movement history as CSV"
                                            >
                                                <ClipboardCopy size={16} aria-hidden />
                                                Copy CSV
                                            </button>
                                        </div>
                                        <div className="stock-movements-wrap">
                                            <table className="stock-table stock-movements-table">
                                                <thead>
                                                    <tr>
                                                        <th>When</th>
                                                        <th>Type</th>
                                                        <th>Applied</th>
                                                        <th>Before</th>
                                                        <th>After</th>
                                                        <th>Note</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {movements.map((m) => (
                                                        <tr key={m.movement_id}>
                                                            <td className="stock-num">{formatMovementWhen(m.created_at)}</td>
                                                            <td>{movementDirectionLabel(m)}</td>
                                                            <td className="stock-num">{formatNum(m.applied_delta)}</td>
                                                            <td className="stock-num">{formatNum(m.stock_before)}</td>
                                                            <td className="stock-num">{formatNum(m.stock_after)}</td>
                                                            <td>
                                                                {movementWasClamped(m) ? (
                                                                    <span className="stock-warn" title="Requested quantity differed from applied (take-out clamped at 0)">
                                                                        Clamped
                                                                    </span>
                                                                ) : (
                                                                    <span className="stock-muted">—</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        {movementsHasMore ? (
                                            <button
                                                type="button"
                                                className="stock-edit-btn stock-movements-more"
                                                disabled={movementsLoadingMore}
                                                onClick={() => void loadMoreMovements()}
                                            >
                                                {movementsLoadingMore ? 'Loading…' : 'Load more'}
                                            </button>
                                        ) : null}
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </aside>
                ) : null}
            </div>
            )}

            {isTouch && touchQtyMaterial ? (
                <div className="stock-touch-qty-overlay" role="presentation" onClick={closeTouchQty}>
                    <div
                        className="stock-touch-qty"
                        role="dialog"
                        aria-label="Edit quantity"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="stock-touch-qty__name">
                            {touchQtyMaterial.material_name ?? touchQtyMaterial.material_id}
                        </p>
                        <div className="stock-touch-qty__controls">
                            <button
                                type="button"
                                className="stock-touch-qty__step"
                                aria-label="Decrease"
                                disabled={touchQtySaving}
                                onClick={() => adjustTouchQty(-1)}
                            >
                                −
                            </button>
                            <input
                                ref={touchQtyInputRef}
                                type="text"
                                inputMode="decimal"
                                className="stock-touch-qty__input"
                                value={touchQtyValue}
                                onChange={(e) => setTouchQtyValue(e.target.value)}
                                aria-label="Quantity"
                            />
                            <button
                                type="button"
                                className="stock-touch-qty__step"
                                aria-label="Increase"
                                disabled={touchQtySaving}
                                onClick={() => adjustTouchQty(1)}
                            >
                                +
                            </button>
                        </div>
                        <div className="stock-touch-qty__actions">
                            <button
                                type="button"
                                className="stock-btn-secondary"
                                disabled={touchQtySaving}
                                onClick={closeTouchQty}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="stock-btn-primary"
                                disabled={touchQtySaving}
                                onClick={() => void confirmTouchQty()}
                            >
                                {touchQtySaving ? 'Saving…' : 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {deleteModalOpen && deleteTargetId ? (
                <div className="stock-modal-overlay" role="presentation" onClick={closeDeleteModal}>
                    <div
                        className="stock-modal stock-modal--narrow"
                        role="dialog"
                        aria-labelledby="stock-delete-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="stock-modal-head">
                            <h3 id="stock-delete-title">Delete material</h3>
                            <button
                                type="button"
                                className="stock-modal-close"
                                onClick={closeDeleteModal}
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <p className="stock-muted" style={{ marginBottom: 8 }}>
                            Permanently remove{' '}
                            <strong>{deleteTargetMaterial?.material_name ?? deleteTargetId}</strong>
                            {deleteTargetMaterial?.material_name ? (
                                <> <span className="stock-muted">({deleteTargetId})</span></>
                            ) : null}
                            ?
                        </p>
                        <p className="stock-muted" style={{ marginBottom: 12 }}>
                            Supplier pricing, conversions, print profiles, and stock movement history for this
                            material are removed as well. This cannot be undone.
                        </p>
                        {deleteError ? <div className="stock-error">{deleteError}</div> : null}
                        <div className="stock-modal-actions">
                            <button type="button" className="stock-btn-secondary" onClick={closeDeleteModal}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="stock-btn-danger"
                                disabled={deleteSaving}
                                onClick={() => void confirmDeleteMaterial()}
                            >
                                {deleteSaving ? 'Deleting…' : 'Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {movementOpen && movementRow ? (
                <div className="stock-modal-overlay" role="presentation" onClick={closeMovement}>
                    <div
                        className="stock-modal stock-modal--narrow"
                        role="dialog"
                        aria-labelledby="stock-move-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="stock-modal-head">
                            <h3 id="stock-move-title">
                                {movementKind === 'issue' ? 'Take out stock' : 'Receive stock'}
                            </h3>
                            <button type="button" className="stock-modal-close" onClick={closeMovement} aria-label="Close">
                                <X size={20} />
                            </button>
                        </div>
                        <p className="stock-muted" style={{ marginBottom: 8 }}>
                            <strong>{movementRow.material_name ?? movementRow.material_id}</strong>
                        </p>
                        <p className="stock-muted">
                            Current on hand: <strong>{formatNum(movementRow.stock)}</strong>{' '}
                            {movementRow.pricing_unit ? `(${movementRow.pricing_unit})` : null}
                        </p>
                        <label className="stock-move-qty">
                            <span>{movementKind === 'issue' ? 'Quantity to remove' : 'Quantity to add'}</span>
                            <input
                                type="text"
                                inputMode="decimal"
                                autoFocus
                                value={movementQtyStr}
                                onChange={(e) => setMovementQtyStr(e.target.value)}
                                aria-label={movementKind === 'issue' ? 'Quantity to remove' : 'Quantity to add'}
                            />
                        </label>
                        <p className="stock-muted">
                            After save: <strong>{formatNum(movementPreview.next)}</strong>
                            {movementPreview.wouldClamp && movementKind === 'issue' ? (
                                <span className="stock-warn"> (requested removal exceeds stock; server will clamp at 0)</span>
                            ) : null}
                        </p>
                        {movementError ? <div className="stock-error">{movementError}</div> : null}
                        <div className="stock-modal-actions">
                            <button type="button" className="stock-btn-secondary" onClick={closeMovement}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="stock-btn-primary"
                                disabled={movementSaving}
                                onClick={() => void confirmMovement()}
                            >
                                {movementSaving ? 'Saving…' : 'Confirm'}
                            </button>
                        </div>
                        <p className="stock-muted" style={{ marginTop: 12 }}>
                            <button
                                type="button"
                                className="stock-link-btn"
                                onClick={() => {
                                    const id = movementRow.material_id;
                                    closeMovement();
                                    void openEditorWithId(id);
                                }}
                            >
                                Open full material editor…
                            </button>
                        </p>
                    </div>
                </div>
            ) : null}

            {editOpen ? (
                <div className="stock-modal-overlay" role="presentation" onClick={closeEditor}>
                    <div
                        className="stock-modal"
                        role="dialog"
                        aria-labelledby="stock-edit-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="stock-modal-head">
                            <h3 id="stock-edit-title">{editorIsCreate ? 'Add material' : 'Edit material'}</h3>
                            <button type="button" className="stock-modal-close" onClick={closeEditor} aria-label="Close">
                                <X size={20} />
                            </button>
                        </div>
                        {editorIsCreate ? (
                            <p className="stock-muted" style={{ padding: '0 0 12px' }}>
                                A new <code style={{ fontSize: '0.85em' }}>material_id</code> is assigned when you
                                save. Default company matches the NL / NP toggle above (change below if needed).
                            </p>
                        ) : null}
                        {editorLoading ? (
                            <p className="stock-muted" style={{ padding: '1rem' }}>
                                Loading…
                            </p>
                        ) : editorRow ? (
                            <>
                                {editorError ? (
                                    <div className="stock-error" style={{ marginBottom: 12 }}>
                                        {editorError}
                                    </div>
                                ) : null}
                                <div className="stock-form-grid">
                                    {editorIsCreate ? (
                                        <label className="stock-form-span2">
                                            <span>Company</span>
                                            <select
                                                value={
                                                    editorRow.company === 'NP Material' ? 'NP Material' : 'NL Material'
                                                }
                                                onChange={(e) =>
                                                    setEditorField(
                                                        'company',
                                                        e.target.value === 'NP Material' ? 'NP Material' : 'NL Material'
                                                    )
                                                }
                                            >
                                                <option value="NL Material">NL Material</option>
                                                <option value="NP Material">NP Material</option>
                                            </select>
                                        </label>
                                    ) : null}
                                    <label>
                                        <span>Stock qty</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={strVal(editorRow.stock)}
                                            onChange={(e) =>
                                                setEditorField('stock', e.target.value as unknown as number)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Reorder level</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={strVal(editorRow.reorder_level)}
                                            onChange={(e) =>
                                                setEditorField('reorder_level', e.target.value as unknown as number)
                                            }
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Internal barcode</span>
                                        <input
                                            type="text"
                                            value={editorRow.internal_barcode ?? ''}
                                            onChange={(e) =>
                                                setEditorField('internal_barcode', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Vendor barcode</span>
                                        <input
                                            type="text"
                                            value={editorRow.vendor_barcode ?? ''}
                                            onChange={(e) =>
                                                setEditorField('vendor_barcode', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Alternate barcode</span>
                                        <input
                                            type="text"
                                            value={editorRow.alternate_barcode ?? ''}
                                            onChange={(e) =>
                                                setEditorField('alternate_barcode', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Location</span>
                                        <input
                                            type="text"
                                            value={editorRow.location ?? ''}
                                            onChange={(e) =>
                                                setEditorField('location', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Material code</span>
                                        <input
                                            type="text"
                                            value={editorRow.material_code ?? ''}
                                            onChange={(e) =>
                                                setEditorField('material_code', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Name</span>
                                        <input
                                            type="text"
                                            value={editorRow.material_name ?? ''}
                                            onChange={(e) =>
                                                setEditorField('material_name', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Substrate group</span>
                                        <SubstrateGroupPicker
                                            groups={groups}
                                            value={groupIdsFromRow(editorRow)}
                                            variant="dropdownRows"
                                            selectClassName="stock-form-group-select"
                                            onGroupsChanged={reloadGroups}
                                            onChange={(ids) => {
                                                setEditorRow((prev) => {
                                                    if (!prev) return prev;
                                                    const refs: StockMaterialGroupRef[] = ids.map((id) => {
                                                        const g = groups.find((x) => x.group_id === id);
                                                        return {
                                                            group_id: id,
                                                            group_name: g?.group_name ?? id,
                                                            group_color: g?.group_color ?? null,
                                                        };
                                                    });
                                                    return {
                                                        ...prev,
                                                        substrate_groups: refs,
                                                        substrate_group: ids[0] ?? null,
                                                        substrate_group_name: refs[0]?.group_name ?? null,
                                                        substrate_group_color: refs[0]?.group_color ?? null,
                                                    };
                                                });
                                            }}
                                        />
                                    </label>
                                    <label>
                                        <span>Pricing unit</span>
                                        <input
                                            type="text"
                                            value={editorRow.pricing_unit ?? ''}
                                            onChange={(e) =>
                                                setEditorField('pricing_unit', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Substrate type</span>
                                        <input
                                            type="text"
                                            value={editorRow.substrate_type ?? ''}
                                            onChange={(e) =>
                                                setEditorField('substrate_type', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Adhesive</span>
                                        <input
                                            type="text"
                                            value={editorRow.adhesive_type ?? ''}
                                            onChange={(e) =>
                                                setEditorField('adhesive_type', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Handling</span>
                                        <input
                                            type="text"
                                            value={editorRow.handling ?? ''}
                                            onChange={(e) => setEditorField('handling', e.target.value || null)}
                                        />
                                    </label>
                                    <label>
                                        <span>Coating</span>
                                        <input
                                            type="text"
                                            value={editorRow.coating ?? ''}
                                            onChange={(e) => setEditorField('coating', e.target.value || null)}
                                        />
                                    </label>
                                    <label>
                                        <span>Grain direction</span>
                                        <input
                                            type="text"
                                            value={editorRow.grain_direction ?? ''}
                                            onChange={(e) =>
                                                setEditorField('grain_direction', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Glossy level</span>
                                        <input
                                            type="text"
                                            value={editorRow.glossy_level ?? ''}
                                            onChange={(e) =>
                                                setEditorField('glossy_level', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Weight (gsm)</span>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            value={strVal(editorRow.weight_gsm)}
                                            onChange={(e) => {
                                                const v = e.target.value.trim();
                                                setEditorField(
                                                    'weight_gsm',
                                                    v === '' ? null : (parseInt(v, 10) as unknown as number)
                                                );
                                            }}
                                        />
                                    </label>
                                    <label>
                                        <span>Width (mm)</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={strVal(editorRow.width_mm)}
                                            onChange={(e) =>
                                                setEditorField('width_mm', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Length (mm)</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={strVal(editorRow.length_mm)}
                                            onChange={(e) =>
                                                setEditorField('length_mm', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Cost (AUD)</span>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={strVal(editorRow.cost_aud)}
                                            onChange={(e) =>
                                                setEditorField('cost_aud', e.target.value || null)
                                            }
                                        />
                                    </label>
                                    <label>
                                        <span>Lead time (days)</span>
                                        <input
                                            type="text"
                                            inputMode="numeric"
                                            value={strVal(editorRow.lead_time_days)}
                                            onChange={(e) => {
                                                const v = e.target.value.trim();
                                                setEditorField(
                                                    'lead_time_days',
                                                    v === '' ? null : (parseInt(v, 10) as unknown as number)
                                                );
                                            }}
                                        />
                                    </label>
                                    <label className="stock-form-span2">
                                        <span>Aliases</span>
                                        <input
                                            type="text"
                                            value={editorRow.aliases ?? ''}
                                            onChange={(e) => setEditorField('aliases', e.target.value || null)}
                                        />
                                    </label>
                                    <label className="stock-form-check">
                                        <input
                                            type="checkbox"
                                            checked={Boolean(editorRow.conductive)}
                                            onChange={(e) => setEditorField('conductive', e.target.checked)}
                                        />
                                        <span>Conductive</span>
                                    </label>
                                    <label className="stock-form-check">
                                        <input
                                            type="checkbox"
                                            checked={Boolean(editorRow.white_material)}
                                            onChange={(e) => setEditorField('white_material', e.target.checked)}
                                        />
                                        <span>White material</span>
                                    </label>
                                    <label className="stock-form-check">
                                        <input
                                            type="checkbox"
                                            checked={editorRow.is_active !== false}
                                            onChange={(e) => setEditorField('is_active', e.target.checked)}
                                        />
                                        <span>Active</span>
                                    </label>
                                </div>
                                <div className="stock-modal-actions">
                                    <button type="button" className="stock-btn-secondary" onClick={closeEditor}>
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="stock-btn-primary"
                                        disabled={editorSaving}
                                        onClick={() => void saveEditor()}
                                    >
                                        {editorSaving ? 'Saving…' : editorIsCreate ? 'Create' : 'Save'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <p className="stock-muted">{editorError ?? 'Nothing to edit.'}</p>
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
