import { ChevronDown, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';

import {
    createStockMaterialGroup,
    type StockMaterialGroupRow,
} from '../../services/api';

export type SubstrateGroupPickerVariant = 'menu' | 'dropdownRows';

export interface SubstrateGroupPickerProps {
    groups: StockMaterialGroupRow[];
    value: string[];
    disabled?: boolean;
    selectRef?: Ref<HTMLButtonElement>;
    className?: string;
    selectClassName?: string;
    /** Checkbox menu (catalog inline) vs single `<select>` (material editor). */
    variant?: SubstrateGroupPickerVariant;
    /** When true, parent commits when the menu closes (catalog inline edit). */
    commitOnClose?: boolean;
    /** Open the checkbox menu on mount (inline catalog edit). */
    defaultOpen?: boolean;
    onChange: (groupIds: string[]) => void;
    onClose?: (draft: string[]) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    onClick?: (e: React.MouseEvent) => void;
    onGroupsChanged?: () => void | Promise<void>;
}

function nonEmptyGroupIds(ids: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        const t = id.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

export default function SubstrateGroupPicker({
    groups,
    value,
    disabled = false,
    selectRef,
    className = '',
    selectClassName = '',
    variant = 'menu',
    commitOnClose = false,
    defaultOpen = false,
    onChange,
    onClose,
    onKeyDown,
    onClick,
    onGroupsChanged,
}: SubstrateGroupPickerProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(defaultOpen);
    const [draft, setDraft] = useState<string[]>(value);
    const [newOpen, setNewOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState('');
    const [newSaving, setNewSaving] = useState(false);
    const [newError, setNewError] = useState<string | null>(null);

    useEffect(() => {
        if (!menuOpen) setDraft(value);
    }, [value, menuOpen]);

    const groupById = useMemo(() => new Map(groups.map((g) => [g.group_id, g])), [groups]);

    const selectedGroupId = value[0] ?? '';

    const summaryLabel = useMemo(() => {
        if (value.length === 0) return '—';
        const names = value
            .map((id) => groupById.get(id)?.group_name ?? id)
            .filter(Boolean);
        if (names.length <= 2) return names.join(', ');
        return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
    }, [value, groupById]);

    const emitChange = useCallback(
        (next: string[]) => {
            onChange(nonEmptyGroupIds(next));
        },
        [onChange]
    );

    const closeMenu = useCallback(
        (apply: boolean) => {
            setMenuOpen(false);
            setNewOpen(false);
            if (apply) {
                if (commitOnClose) onClose?.(nonEmptyGroupIds(draft));
                else emitChange(draft);
            }
        },
        [commitOnClose, draft, emitChange, onClose]
    );

    const toggleGroup = useCallback(
        (groupId: string) => {
            setDraft((prev) => {
                const next = prev.includes(groupId)
                    ? prev.filter((id) => id !== groupId)
                    : [...prev, groupId];
                if (!commitOnClose) emitChange(next);
                return next;
            });
        },
        [commitOnClose, emitChange]
    );

    const closeNewForm = useCallback(() => {
        setNewOpen(false);
        setNewName('');
        setNewColor('');
        setNewError(null);
    }, []);

    const openNewForm = useCallback(() => {
        setNewOpen(true);
        setNewError(null);
    }, []);

    useEffect(() => {
        if (!newOpen) return;
        nameInputRef.current?.focus();
    }, [newOpen]);

    useEffect(() => {
        if (variant !== 'menu' || !menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) {
                closeMenu(true);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [variant, menuOpen, closeMenu]);

    const saveNewGroup = useCallback(async () => {
        const name = newName.trim();
        if (!name) {
            setNewError('Group name is required.');
            nameInputRef.current?.focus();
            return;
        }
        setNewSaving(true);
        setNewError(null);
        try {
            const color = newColor.trim() || null;
            const created = await createStockMaterialGroup({
                group_name: name,
                group_color: color,
            });
            await onGroupsChanged?.();
            if (variant === 'dropdownRows') {
                emitChange([created.group_id]);
            } else {
                setDraft((prev) => {
                    const next = prev.includes(created.group_id) ? prev : [...prev, created.group_id];
                    if (!commitOnClose) emitChange(next);
                    return next;
                });
            }
            closeNewForm();
        } catch (e) {
            setNewError(e instanceof Error ? e.message : 'Failed to create group');
            nameInputRef.current?.focus();
        } finally {
            setNewSaving(false);
        }
    }, [newName, newColor, onGroupsChanged, variant, emitChange, commitOnClose, closeNewForm]);

    const setRefs = useCallback(
        (el: HTMLButtonElement | null) => {
            triggerRef.current = el;
            if (typeof selectRef === 'function') {
                selectRef(el);
            }
        },
        [selectRef]
    );

    const triggerClassName =
        selectClassName.trim() || 'stock-group-multiselect-trigger';

    useEffect(() => {
        if (variant !== 'menu' || !menuOpen) return;
        triggerRef.current?.focus();
    }, [variant, menuOpen]);

    const setSelectedGroup = useCallback(
        (groupId: string) => {
            emitChange(groupId.trim() ? [groupId.trim()] : []);
        },
        [emitChange]
    );

    const selectClass =
        selectClassName.trim() || 'stock-form-group-select';

    const newGroupPopover = newOpen ? (
        <div
            className="stock-group-new-popover"
            role="dialog"
            aria-label="New substrate group"
            onClick={(e) => e.stopPropagation()}
        >
            <label>
                <span>Name</span>
                <input
                    ref={nameInputRef}
                    type="text"
                    value={newName}
                    disabled={newSaving}
                    placeholder="e.g. Label Rolls"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void saveNewGroup();
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            closeNewForm();
                        }
                    }}
                />
            </label>
            <label>
                <span>Color</span>
                <input
                    type="color"
                    value={newColor || '#4A90E2'}
                    disabled={newSaving}
                    onChange={(e) => setNewColor(e.target.value)}
                />
            </label>
            {newError ? <p className="stock-group-new-error">{newError}</p> : null}
            <div className="stock-group-new-actions">
                <button type="button" className="stock-btn-secondary" disabled={newSaving} onClick={closeNewForm}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="stock-btn-primary"
                    disabled={newSaving}
                    onClick={() => void saveNewGroup()}
                >
                    {newSaving ? 'Saving…' : 'Save group'}
                </button>
            </div>
        </div>
    ) : null;

    if (variant === 'dropdownRows') {
        return (
            <div
                className={`stock-group-picker stock-group-picker--dropdown-rows ${className}`.trim()}
                ref={containerRef}
            >
                <select
                    className={selectClass}
                    value={selectedGroupId}
                    disabled={disabled || newSaving}
                    aria-label="Substrate group"
                    onChange={(e) => setSelectedGroup(e.target.value)}
                >
                    <option value="">Select group…</option>
                    {groups.map((g) => (
                        <option key={g.group_id} value={g.group_id}>
                            {g.group_name}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="stock-link-btn"
                    disabled={disabled || newSaving}
                    onClick={openNewForm}
                >
                    Create new group…
                </button>
                {newGroupPopover}
            </div>
        );
    }

    return (
        <div className={`stock-group-picker ${className}`.trim()} ref={containerRef}>
            <button
                ref={setRefs}
                type="button"
                className={triggerClassName}
                disabled={disabled || newSaving}
                aria-expanded={menuOpen}
                aria-haspopup="listbox"
                onClick={(e) => {
                    onClick?.(e);
                    e.stopPropagation();
                    setMenuOpen((o) => !o);
                }}
                onKeyDown={(e) => {
                    onKeyDown?.(e);
                    if (e.key === 'Escape' && menuOpen) {
                        e.preventDefault();
                        e.stopPropagation();
                        closeMenu(false);
                    }
                }}
            >
                <span className="stock-group-multiselect-label">{summaryLabel}</span>
                <ChevronDown size={14} aria-hidden />
            </button>
            <button
                type="button"
                className="stock-group-add-btn"
                title="Add substrate group"
                aria-label="Add substrate group"
                disabled={disabled || newSaving}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(true);
                    openNewForm();
                }}
            >
                <Plus size={16} aria-hidden />
            </button>
            {menuOpen ? (
                <div
                    className="stock-group-menu"
                    role="listbox"
                    aria-multiselectable
                    aria-label="Substrate groups"
                    onClick={(e) => e.stopPropagation()}
                >
                    <ul className="stock-group-menu-list">
                        {groups.map((g) => {
                            const checked = draft.includes(g.group_id);
                            return (
                                <li key={g.group_id}>
                                    <label className="stock-group-menu-option">
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={disabled || newSaving}
                                            onChange={() => toggleGroup(g.group_id)}
                                        />
                                        {g.group_color ? (
                                            <span
                                                className="stock-group-dot"
                                                style={{ backgroundColor: g.group_color }}
                                                aria-hidden
                                            />
                                        ) : (
                                            <span className="stock-group-dot" style={{ opacity: 0.3 }} aria-hidden />
                                        )}
                                        <span>{g.group_name}</span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                    {commitOnClose ? (
                        <div className="stock-group-menu-footer">
                            <button
                                type="button"
                                className="stock-btn-primary"
                                disabled={disabled || newSaving}
                                onClick={() => closeMenu(true)}
                            >
                                Done
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}
            {newGroupPopover}
        </div>
    );
}
