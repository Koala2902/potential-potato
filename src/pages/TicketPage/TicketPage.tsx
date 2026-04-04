import { useState, useEffect, useRef, useCallback } from 'react';
import ProductionQueueList from '../../components/LeftPanel/ProductionQueueList';
import ImpositionViewer from '../../components/MiddlePanel/ImpositionViewer';
import { ProductionQueueItem, ImpositionItem, ImpositionDetails } from '../../types';
import {
    fetchProductionQueue,
    fetchImpositionDetails,
    fetchFileIds,
    processScan,
    fetchMachines,
    Machine,
} from '../../services/api';
import { Settings, ChevronDown, AlertCircle, X, Package, Hash, FileText } from 'lucide-react';
import './TicketPage.css';

export default function TicketPage() {
    const [queue, setQueue] = useState<ProductionQueueItem[]>([]);
    const [selectedImposition, setSelectedImposition] = useState<ImpositionItem | null>(null);
    const [impositionDetails, setImpositionDetails] = useState<ImpositionDetails | null>(null);
    const [fileIds, setFileIds] = useState<string[]>([]);
    const [expandedRunlists, setExpandedRunlists] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [hasScanned, setHasScanned] = useState(false);
    const scanBufferRef = useRef<string>('');
    const scanTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const [machines, setMachines] = useState<Machine[]>([]);
    const [selectedMachineId, setSelectedMachineId] = useState<string>('');
    const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
    const [showSettings, setShowSettings] = useState(true);
    const [notification, setNotification] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
    const [manualScan, setManualScan] = useState('');

    const loadProductionQueue = async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await fetchProductionQueue();
            setQueue(data);
            if (data.length > 0) {
                setExpandedRunlists(new Set([data[0].runlist_id]));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load production queue');
            console.error('Error loading production queue:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const loadMachines = async () => {
            try {
                const machinesData = await fetchMachines();
                setMachines(machinesData);
            } catch (err) {
                console.error('Error loading machines:', err);
            }
        };
        loadMachines();
    }, []);

    useEffect(() => {
        loadProductionQueue();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const processScanValue = useCallback(async (scanValue: string): Promise<boolean> => {
        if (!scanValue.trim() || isScanning) {
            return false;
        }

        if (!selectedMachineId.trim()) {
            setNotification({
                message: 'Select a machine before scanning',
                type: 'error',
            });
            return false;
        }

        try {
            setIsScanning(true);
            setError(null);
            setNotification(null);

            const { runlistId, queue: filteredQueue, scannedImpositionId } = await processScan(
                scanValue,
                selectedMachineId || null,
                null
            );

            setQueue(filteredQueue);
            setHasScanned(true);

            if (filteredQueue.length > 0) {
                setExpandedRunlists(new Set([runlistId]));

                if (scannedImpositionId && filteredQueue[0]?.impositions) {
                    const scannedImposition = filteredQueue[0].impositions.find(
                        (imp) => imp.imposition_id === scannedImpositionId
                    );
                    if (scannedImposition) {
                        setSelectedImposition(scannedImposition);
                    } else if (filteredQueue[0].impositions.length > 0) {
                        setSelectedImposition(filteredQueue[0].impositions[0]);
                    }
                } else if (filteredQueue[0]?.impositions && filteredQueue[0].impositions.length > 0) {
                    setSelectedImposition(filteredQueue[0].impositions[0]);
                }
            }

            scanBufferRef.current = '';
            return true;
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to process scan';

            if (errorMessage.includes('No runlist found') || errorMessage.includes('No imposition')) {
                setNotification({
                    message: 'No runlist or imposition ID found for this scan',
                    type: 'error',
                });
            } else {
                setNotification({
                    message: errorMessage,
                    type: 'error',
                });
            }

            console.error('Error processing scan:', err);
            return false;
        } finally {
            setIsScanning(false);
        }
    }, [isScanning, selectedMachineId]);

    useEffect(() => {
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

                if (
                    bufferedValue &&
                    bufferedValue.length > 0 &&
                    selectedMachineId.trim() &&
                    !isScanning
                ) {
                    scanBufferRef.current = '';
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    processScanValue(bufferedValue);
                } else {
                    scanBufferRef.current = '';
                }
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
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                }

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
            if (scanTimeoutRef.current) {
                clearTimeout(scanTimeoutRef.current);
            }
        };
    }, [selectedMachineId, isScanning, processScanValue]);

    useEffect(() => {
        if (notification) {
            const timer = setTimeout(() => {
                setNotification(null);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [notification]);

    useEffect(() => {
        if (selectedImposition) {
            loadImpositionDetails(selectedImposition.imposition_id);
        } else {
            setImpositionDetails(null);
            setFileIds([]);
        }
    }, [selectedImposition]);

    const loadImpositionDetails = async (impositionId: string) => {
        try {
            const [details, ids] = await Promise.all([
                fetchImpositionDetails(impositionId),
                fetchFileIds(impositionId),
            ]);
            setImpositionDetails(details);
            setFileIds(details?.file_ids || ids);
        } catch (err) {
            console.error('Error loading imposition details:', err);
            setImpositionDetails(null);
            setFileIds([]);
        }
    };

    const handleSelectImposition = (imposition: ImpositionItem, _runlistId: string) => {
        setSelectedImposition(imposition);
    };

    const handleManualScanSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const ok = await processScanValue(manualScan.trim());
        if (ok) {
            setManualScan('');
        }
    };

    const handleToggleRunlist = (runlistId: string) => {
        setExpandedRunlists((prev) => {
            const newSet = new Set(prev);
            if (newSet.has(runlistId)) {
                newSet.delete(runlistId);
            } else {
                newSet.add(runlistId);
            }
            return newSet;
        });
    };

    if (loading) {
        return (
            <div className="ticket-page">
                <div className="loading-state">
                    <p>Loading production queue...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="ticket-page">
                <div className="error-state">
                    <p>Error: {error}</p>
                    <button onClick={loadProductionQueue}>Retry</button>
                </div>
            </div>
        );
    }

    return (
        <div className="ticket-page">
            <div className="left-panel">
                <form className="manual-scan-bar" onSubmit={handleManualScanSubmit}>
                    <label className="manual-scan-bar__label" htmlFor="manual-scan-input">
                        Manual scan
                    </label>
                    <div className="manual-scan-bar__row">
                        <input
                            id="manual-scan-input"
                            type="text"
                            className="manual-scan-bar__input"
                            value={manualScan}
                            onChange={(e) => setManualScan(e.target.value)}
                            placeholder="Type or paste code"
                            disabled={isScanning}
                            autoComplete="off"
                        />
                        <button
                            type="submit"
                            className="manual-scan-bar__submit"
                            disabled={isScanning}
                        >
                            Submit
                        </button>
                    </div>
                </form>
                <div
                    className="operation-settings"
                    style={{
                        padding: 'var(--spacing-md)',
                        borderBottom: '1px solid var(--border-color)',
                        background: 'var(--bg-secondary)',
                    }}
                >
                    <div
                        className="settings-header"
                        onClick={() => setShowSettings(!showSettings)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            cursor: 'pointer',
                            userSelect: 'none',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                            <Settings size={16} />
                            <span
                                style={{
                                    fontSize: '0.875rem',
                                    fontWeight: 600,
                                    color: 'var(--text-primary)',
                                }}
                            >
                                Scan settings
                            </span>
                        </div>
                        <ChevronDown
                            size={16}
                            style={{
                                transform: showSettings ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s ease',
                                color: 'var(--text-secondary)',
                            }}
                        />
                    </div>

                    {showSettings && (
                        <div
                            style={{
                                marginTop: 'var(--spacing-md)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 'var(--spacing-md)',
                            }}
                        >
                            <div>
                                <label
                                    style={{
                                        display: 'block',
                                        marginBottom: 'var(--spacing-xs)',
                                        fontSize: '0.8125rem',
                                        color: 'var(--text-secondary)',
                                        fontWeight: 500,
                                    }}
                                >
                                    Machine
                                </label>
                                <select
                                    value={selectedMachineId}
                                    onChange={(e) => {
                                        const machineId = e.target.value;
                                        setSelectedMachineId(machineId);
                                        setSelectedMachine(
                                            machines.find((m) => m.machine_id === machineId) || null
                                        );
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                        width: '100%',
                                        padding: 'var(--spacing-sm) var(--spacing-md)',
                                        background: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-sm)',
                                        color: 'var(--text-primary)',
                                        fontSize: '0.875rem',
                                        cursor: 'pointer',
                                        position: 'relative',
                                        zIndex: 10,
                                        pointerEvents: 'auto',
                                    }}
                                >
                                    <option value="">Select machine ({machines.length} available)</option>
                                    {machines.map((machine) => (
                                        <option key={machine.machine_id} value={machine.machine_id}>
                                            {machine.machine_name}
                                            {machine.machine_type ? ` (${machine.machine_type})` : ''}
                                        </option>
                                    ))}
                                </select>
                                {selectedMachine && (
                                    <p
                                        style={{
                                            margin: 'var(--spacing-sm) 0 0',
                                            fontSize: '0.75rem',
                                            color: 'var(--text-secondary)',
                                        }}
                                    >
                                        Scans are recorded for this machine only (no operation selection).
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {notification && (
                    <div style={{ padding: 'var(--spacing-md)', borderBottom: '1px solid var(--border-color)' }}>
                        <div
                            style={{
                                padding: 'var(--spacing-sm) var(--spacing-md)',
                                background:
                                    notification.type === 'error'
                                        ? 'rgba(239, 68, 68, 0.1)'
                                        : 'rgba(34, 197, 94, 0.1)',
                                border: `1px solid ${
                                    notification.type === 'error'
                                        ? 'rgba(239, 68, 68, 0.3)'
                                        : 'rgba(34, 197, 94, 0.3)'
                                }`,
                                borderRadius: 'var(--radius-sm)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 'var(--spacing-sm)',
                                color:
                                    notification.type === 'error'
                                        ? 'rgb(239, 68, 68)'
                                        : 'rgb(34, 197, 94)',
                                fontSize: '0.75rem',
                            }}
                        >
                            <AlertCircle size={14} />
                            <span style={{ flex: 1 }}>{notification.message}</span>
                            <button
                                onClick={() => setNotification(null)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'inherit',
                                    cursor: 'pointer',
                                    padding: '2px',
                                    display: 'flex',
                                    alignItems: 'center',
                                }}
                            >
                                <X size={12} />
                            </button>
                        </div>
                    </div>
                )}
                {hasScanned && (
                    <ProductionQueueList
                        queue={queue}
                        selectedImpositionId={selectedImposition?.imposition_id || null}
                        onSelectImposition={handleSelectImposition}
                        expandedRunlists={expandedRunlists}
                        onToggleRunlist={handleToggleRunlist}
                    />
                )}
            </div>

            <div className="middle-panel" style={{ flex: 1 }}>
                <ImpositionViewer
                    imposition={selectedImposition}
                    details={impositionDetails}
                    fileIds={fileIds}
                />
            </div>

            <div
                className="right-panel"
                style={{
                    background: 'var(--bg-tertiary)',
                    borderLeft: '1px solid var(--border-color)',
                    padding: 'var(--spacing-md)',
                    overflowY: 'auto',
                }}
            >
                {selectedImposition ? (
                    <>
                        <h3
                            style={{
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                color: 'var(--text-secondary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                margin: '0 0 var(--spacing-sm) 0',
                            }}
                        >
                            Imposition Details
                        </h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                            {fileIds.length > 0 && (
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: 'var(--spacing-xs)',
                                        padding: 'var(--spacing-sm)',
                                        background: 'rgba(255, 255, 255, 0.03)',
                                        border: '1px solid rgba(255, 255, 255, 0.05)',
                                        borderRadius: 'var(--radius-sm)',
                                    }}
                                >
                                    <div
                                        style={{
                                            width: '24px',
                                            height: '24px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'rgba(99, 102, 241, 0.15)',
                                            borderRadius: 'var(--radius-xs)',
                                            color: 'var(--accent-primary)',
                                            flexShrink: 0,
                                        }}
                                    >
                                        <Package size={14} />
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div
                                            style={{
                                                fontSize: '0.75rem',
                                                color: 'var(--text-secondary)',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.05em',
                                                marginBottom: 'var(--spacing-xs)',
                                            }}
                                        >
                                            File IDs ({fileIds.length})
                                        </div>
                                        <div
                                            className="ticket-page__fileids-scroll"
                                            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}
                                        >
                                            {fileIds.map((fileId, index) => {
                                                const match =
                                                    fileId.match(/^(FILE_\d+_\d+_\d+)(?:_|$)/) ||
                                                    fileId.match(/^(FILE_\d+)_Labex_(\d+_\d+)(?:_|$)/);
                                                const simplified = match
                                                    ? match[2]
                                                        ? `${match[1]}_${match[2]}`
                                                        : match[1]
                                                    : fileId;
                                                return (
                                                    <div
                                                        key={index}
                                                        style={{
                                                            padding: 'var(--spacing-xs) var(--spacing-sm)',
                                                            background: 'var(--bg-tertiary)',
                                                            borderRadius: 'var(--radius-sm)',
                                                            fontSize: '0.8rem',
                                                            color: 'var(--text-primary)',
                                                            wordBreak: 'break-all',
                                                        }}
                                                    >
                                                        {simplified}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {impositionDetails &&
                                Object.entries(impositionDetails).map(([key, value]) => {
                                    const skipFields = [
                                        'imposition_id',
                                        'file_id',
                                        'file_ids',
                                        'runlist_id',
                                        'production_path',
                                        'material',
                                        'finishing',
                                        'product_id',
                                        'pages',
                                        'steps_count',
                                        'layout_around',
                                        'imposed_file_path',
                                        'imposition_created_at',
                                        'created_at',
                                    ];
                                    if (skipFields.includes(key) || value === null || value === undefined)
                                        return null;

                                    return (
                                        <div
                                            key={key}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'flex-start',
                                                gap: 'var(--spacing-xs)',
                                                padding: 'var(--spacing-sm)',
                                                background: 'rgba(255, 255, 255, 0.03)',
                                                border: '1px solid rgba(255, 255, 255, 0.05)',
                                                borderRadius: 'var(--radius-sm)',
                                            }}
                                        >
                                            <div
                                                style={{
                                                    width: '24px',
                                                    height: '24px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    background: 'rgba(99, 102, 241, 0.15)',
                                                    borderRadius: 'var(--radius-xs)',
                                                    color: 'var(--accent-primary)',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {key === 'explanation' ? <FileText size={14} /> : <Hash size={14} />}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div
                                                    style={{
                                                        fontSize: '0.75rem',
                                                        color: 'var(--text-secondary)',
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.05em',
                                                        marginBottom: 'var(--spacing-xs)',
                                                    }}
                                                >
                                                    {key.replace(/_/g, ' ')}
                                                </div>
                                                <div
                                                    style={{
                                                        fontSize: '0.875rem',
                                                        fontWeight: 500,
                                                        color: 'var(--text-primary)',
                                                        wordBreak: 'break-word',
                                                        whiteSpace: key === 'explanation' ? 'pre-wrap' : 'normal',
                                                    }}
                                                >
                                                    {String(value)}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    </>
                ) : (
                    <div
                        style={{
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--text-tertiary)',
                            textAlign: 'center',
                        }}
                    >
                        <FileText size={48} style={{ opacity: 0.3, marginBottom: 'var(--spacing-md)' }} />
                        <div style={{ fontSize: '0.875rem' }}>No imposition selected</div>
                    </div>
                )}
            </div>
        </div>
    );
}
