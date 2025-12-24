import { useState, useEffect, useRef, useCallback } from 'react';
import ProductionQueueList from '../../components/LeftPanel/ProductionQueueList';
import ImpositionViewer from '../../components/MiddlePanel/ImpositionViewer';
import { ProductionQueueItem, ImpositionItem, ImpositionDetails } from '../../types';
import { fetchProductionQueue, fetchImpositionDetails, fetchFileIds, processScan, fetchMachines, fetchOperations, Machine, Operation } from '../../services/api';
import { Settings, ChevronDown, AlertCircle, X, Package, Hash, FileText } from 'lucide-react';

// Hidden input ref for barcode scanning (scanner sends keystrokes)
// We don't need a visible input bar - the global keyboard listener handles scanning

export default function TicketPage() {
    const [queue, setQueue] = useState<ProductionQueueItem[]>([]);
    const [selectedImposition, setSelectedImposition] = useState<ImpositionItem | null>(null);
    const [impositionDetails, setImpositionDetails] = useState<ImpositionDetails | null>(null);
    const [fileIds, setFileIds] = useState<string[]>([]);
    const [expandedRunlists, setExpandedRunlists] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [hasScanned, setHasScanned] = useState(false); // Track if any job has been scanned
    const scanBufferRef = useRef<string>('');
    const scanTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    
    // Machine and operation selection
    const [machines, setMachines] = useState<Machine[]>([]);
    const [operations, setOperations] = useState<Operation[]>([]);
    const [selectedMachineId, setSelectedMachineId] = useState<string>('');
    const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
    const [selectedOperations, setSelectedOperations] = useState<string[]>([]); // Array of operation_ids
    const [showSettings, setShowSettings] = useState(true); // Start expanded
    const [notification, setNotification] = useState<{ message: string; type: 'error' | 'success' } | null>(null);

    const loadProductionQueue = async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await fetchProductionQueue();
            setQueue(data);
            // Expand first runlist by default
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

    // Fetch machines on mount
    useEffect(() => {
        const loadMachines = async () => {
            try {
                const machinesData = await fetchMachines();
                console.log('Loaded machines:', machinesData);
                setMachines(machinesData);
            } catch (err) {
                console.error('Error loading machines:', err);
            }
        };
        loadMachines();
    }, []);

    // Load production queue on mount
    useEffect(() => {
        loadProductionQueue();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch all operations on mount (no machine filtering)
    useEffect(() => {
        const loadOperations = async () => {
            try {
                const operationsData = await fetchOperations();
                setOperations(operationsData);
            } catch (err) {
                console.error('Error loading operations:', err);
            }
        };
        loadOperations();
    }, []);

    // Extract scan processing logic into a separate function with useCallback
    const processScanValue = useCallback(async (scanValue: string) => {
        if (!scanValue.trim() || isScanning) {
            return;
        }

        // Validate that operations are selected
        if (selectedOperations.length === 0) {
            setNotification({
                message: 'Please select at least one operation before scanning',
                type: 'error'
            });
            return;
        }

        try {
            setIsScanning(true);
            setError(null);
            setNotification(null);

            // Process scan and get filtered runlist (with machine and operations if selected)
            // Use scan value as-is (preserve underscores from scanner)
            const { runlistId, queue: filteredQueue, scannedImpositionId } = await processScan(
                scanValue,
                selectedMachineId || null,
                selectedOperations.length > 0 ? selectedOperations : null
            );
            
            setQueue(filteredQueue);
            setHasScanned(true); // Mark that a scan has occurred
            
            // Expand the runlist automatically
            if (filteredQueue.length > 0) {
                setExpandedRunlists(new Set([runlistId]));
                
                // Auto-select the scanned imposition if provided, otherwise first one
                if (scannedImpositionId && filteredQueue[0]?.impositions) {
                    const scannedImposition = filteredQueue[0].impositions.find(
                        imp => imp.imposition_id === scannedImpositionId
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

            // Clear scan buffer
            scanBufferRef.current = '';
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to process scan';
            
            // If no runlist found, show notification but keep the current queue
            if (errorMessage.includes('No runlist found') || errorMessage.includes('No imposition')) {
                setNotification({
                    message: 'No runlist or imposition ID found for this scan',
                    type: 'error'
                });
                // Keep the current queue visible, don't clear it
            } else {
                // For other errors, still show notification but don't clear queue
                setNotification({
                    message: errorMessage,
                    type: 'error'
                });
            }
            
            console.error('Error processing scan:', err);
        } finally {
            setIsScanning(false);
        }
    }, [isScanning, selectedOperations, selectedMachineId]);

    // Global keyboard listener for QR code scanning (works without input focus)
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            // Ignore if user is typing in an input field, textarea, or contenteditable element
            const target = e.target as HTMLElement;
            const isInputElement = target.tagName === 'INPUT' || 
                                 target.tagName === 'TEXTAREA' || 
                                 target.isContentEditable ||
                                 (target.tagName === 'SELECT');
            
            // If user is typing in an input, ignore
            if (isInputElement) {
                scanBufferRef.current = '';
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                    scanTimeoutRef.current = null;
                }
                return;
            }

            // Handle Enter key - process the buffered scan
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                
                const bufferedValue = scanBufferRef.current.trim();
                
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                    scanTimeoutRef.current = null;
                }

                // Process scan if we have a value and operations are selected
                if (bufferedValue && bufferedValue.length > 0 && selectedOperations.length > 0 && !isScanning) {
                    console.log('[Global Scan] Processing buffered scan:', bufferedValue);
                    scanBufferRef.current = '';
                    // Trigger scan processing with raw value (preserve underscores)
                    processScanValue(bufferedValue);
                } else {
                    // Clear buffer if conditions not met
                    scanBufferRef.current = '';
                }
                return;
            }

            // Handle regular character input (for barcode scanners)
            // Capture all printable characters including underscores (even with Shift key)
            // Underscore is typically Shift+Minus, so we need to allow Shift for underscore
            if (e.key === '_' || 
                (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && 
                 (e.key.match(/[a-zA-Z0-9_\-]/) || (e.key === '-' && e.shiftKey)))) {
                // Clear any existing timeout
                if (scanTimeoutRef.current) {
                    clearTimeout(scanTimeoutRef.current);
                }

                // Add character to buffer (use '_' if Shift+Minus, otherwise use the key)
                const charToAdd = (e.key === '-' && e.shiftKey) ? '_' : e.key;
                scanBufferRef.current += charToAdd;
                console.log('[Global Scan] Buffer updated:', scanBufferRef.current);

                // Clear buffer after 500ms of no input (prevents accidental capture of normal typing)
                // Increased from 100ms to 500ms to better handle barcode scanner timing
                scanTimeoutRef.current = setTimeout(() => {
                    console.log('[Global Scan] Buffer timeout - clearing:', scanBufferRef.current);
                    scanBufferRef.current = '';
                }, 500);
            } else if (e.key === 'Backspace' || e.key === 'Delete') {
                // Handle backspace/delete - clear buffer if user is correcting
                if (scanBufferRef.current.length > 0) {
                    scanBufferRef.current = scanBufferRef.current.slice(0, -1);
                }
            }
        };

        // Add global event listener with capture phase to catch events early
        window.addEventListener('keydown', handleGlobalKeyDown, true);

        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown, true);
            if (scanTimeoutRef.current) {
                clearTimeout(scanTimeoutRef.current);
            }
        };
    }, [selectedOperations, isScanning, processScanValue]);

    // Auto-dismiss notification after 5 seconds
    useEffect(() => {
        if (notification) {
            const timer = setTimeout(() => {
                setNotification(null);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [notification]);

    // Fetch details when imposition is selected
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
            // Use file_ids from details if available, otherwise use the fetched ones
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
                {/* Machine and Operation Selection */}
                <div className="operation-settings" style={{ 
                    padding: 'var(--spacing-md)', 
                    borderBottom: '1px solid var(--border-color)',
                    background: 'var(--bg-secondary)'
                }}>
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
                            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                Operation Settings
                            </span>
                        </div>
                        <ChevronDown 
                            size={16} 
                            style={{ 
                                transform: showSettings ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s ease',
                                color: 'var(--text-secondary)'
                            }} 
                        />
                    </div>
                    
                    {showSettings && (
                        <div style={{ 
                            marginTop: 'var(--spacing-md)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 'var(--spacing-md)'
                        }}>
                            <div>
                                <label style={{ 
                                    display: 'block', 
                                    marginBottom: 'var(--spacing-xs)',
                                    fontSize: '0.8125rem',
                                    color: 'var(--text-secondary)',
                                    fontWeight: 500
                                }}>
                                    Machine
                                </label>
                                <select
                                    value={selectedMachineId}
                                    onChange={(e) => {
                                        console.log('Machine selected:', e.target.value);
                                        const machineId = e.target.value;
                                        setSelectedMachineId(machineId);
                                        const machine = machines.find(m => m.machine_id === machineId) || null;
                                        setSelectedMachine(machine);
                                    }}
                                    onClick={(e) => {
                                        console.log('Select clicked');
                                        e.stopPropagation();
                                    }}
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
                                    <option value="">Select Machine ({machines.length} available)</option>
                                    {machines.map((machine) => (
                                        <option key={machine.machine_id} value={machine.machine_id}>
                                            {machine.machine_name} ({machine.machine_type})
                                        </option>
                                    ))}
                                </select>
                            </div>
                            
                            <div>
                                <label style={{ 
                                    display: 'block', 
                                    marginBottom: 'var(--spacing-sm)',
                                    fontSize: '0.8125rem',
                                    color: 'var(--text-secondary)',
                                    fontWeight: 500
                                }}>
                                    Operations {selectedOperations.length > 0 && `(${selectedOperations.length} selected)`}
                                </label>
                                {!selectedMachine ? (
                                    <div style={{
                                        padding: 'var(--spacing-md)',
                                        background: 'var(--bg-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-sm)',
                                        color: 'var(--text-tertiary)',
                                        fontSize: '0.875rem',
                                        textAlign: 'center',
                                    }}>
                                        Select Machine First
                                    </div>
                                ) : operations.length === 0 ? (
                                    <div style={{
                                        padding: 'var(--spacing-md)',
                                        background: 'var(--bg-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-sm)',
                                        color: 'var(--text-tertiary)',
                                        fontSize: '0.875rem',
                                        textAlign: 'center',
                                    }}>
                                        No operations available for this machine
                                    </div>
                                ) : (
                                    <div style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 'var(--spacing-sm)',
                                        padding: 'var(--spacing-sm)',
                                        background: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-sm)',
                                        maxHeight: '200px',
                                        overflowY: 'auto',
                                    }}>
                                        {operations.map((op) => {
                                            const isChecked = selectedOperations.includes(op.operation_id);
                                            return (
                                                <label
                                                    key={op.operation_id}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 'var(--spacing-sm)',
                                                        padding: 'var(--spacing-xs) var(--spacing-sm)',
                                                        cursor: 'pointer',
                                                        borderRadius: 'var(--radius-sm)',
                                                        transition: 'background-color 0.2s ease',
                                                        userSelect: 'none',
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.background = 'var(--bg-hover)';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.background = 'transparent';
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={isChecked}
                                                        onChange={(e) => {
                                                            if (e.target.checked) {
                                                                setSelectedOperations([...selectedOperations, op.operation_id]);
                                                            } else {
                                                                setSelectedOperations(selectedOperations.filter(o => o !== op.operation_id));
                                                            }
                                                        }}
                                                        style={{
                                                            width: '16px',
                                                            height: '16px',
                                                            cursor: 'pointer',
                                                            accentColor: 'var(--accent-primary)',
                                                        }}
                                                    />
                                                    <span style={{
                                                        fontSize: '0.875rem',
                                                        color: 'var(--text-primary)',
                                                        flex: 1,
                                                    }}>
                                                        {op.operation_name}
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Notification Area */}
                {notification && (
                    <div style={{ padding: 'var(--spacing-md)', borderBottom: '1px solid var(--border-color)' }}>
                        <div
                            style={{
                                padding: 'var(--spacing-sm) var(--spacing-md)',
                                background: notification.type === 'error' 
                                    ? 'rgba(239, 68, 68, 0.1)' 
                                    : 'rgba(34, 197, 94, 0.1)',
                                border: `1px solid ${notification.type === 'error' 
                                    ? 'rgba(239, 68, 68, 0.3)' 
                                    : 'rgba(34, 197, 94, 0.3)'}`,
                                borderRadius: 'var(--radius-sm)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 'var(--spacing-sm)',
                                color: notification.type === 'error' 
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
                {/* Only show production queue if a job has been scanned */}
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

            {/* Right Panel - Imposition Details */}
            <div className="right-panel" style={{
                background: 'var(--bg-tertiary)',
                borderLeft: '1px solid var(--border-color)',
                padding: 'var(--spacing-md)',
                overflowY: 'auto',
            }}>
                {selectedImposition ? (
                    <>
                        <h3 style={{
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            margin: '0 0 var(--spacing-sm) 0',
                        }}>
                            Imposition Details
                        </h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                            {/* File IDs */}
                            {fileIds.length > 0 && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 'var(--spacing-xs)',
                                    padding: 'var(--spacing-sm)',
                                    background: 'rgba(255, 255, 255, 0.03)',
                                    border: '1px solid rgba(255, 255, 255, 0.05)',
                                    borderRadius: 'var(--radius-sm)',
                                }}>
                                    <div style={{
                                        width: '24px',
                                        height: '24px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'rgba(99, 102, 241, 0.15)',
                                        borderRadius: 'var(--radius-xs)',
                                        color: 'var(--accent-primary)',
                                        flexShrink: 0,
                                    }}>
                                        <Package size={14} />
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            fontSize: '0.75rem',
                                            color: 'var(--text-secondary)',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.05em',
                                            marginBottom: 'var(--spacing-xs)',
                                        }}>
                                            File IDs ({fileIds.length})
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                                            {fileIds.map((fileId, index) => {
                                                const match = fileId.match(/^(FILE_\d+_\d+_\d+)(?:_|$)/) 
                                                    || fileId.match(/^(FILE_\d+)_Labex_(\d+_\d+)(?:_|$)/);
                                                const simplified = match ? (match[2] ? `${match[1]}_${match[2]}` : match[1]) : fileId;
                                                return (
                                                    <div key={index} style={{
                                                        padding: 'var(--spacing-xs) var(--spacing-sm)',
                                                        background: 'var(--bg-tertiary)',
                                                        borderRadius: 'var(--radius-sm)',
                                                        fontSize: '0.8rem',
                                                        color: 'var(--text-primary)',
                                                        wordBreak: 'break-all',
                                                    }}>
                                                        {simplified}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Other Details */}
                            {impositionDetails && Object.entries(impositionDetails).map(([key, value]) => {
                                const skipFields = [
                                    'imposition_id', 'file_id', 'file_ids', 'runlist_id',
                                    'production_path', 'material', 'finishing', 'product_id',
                                    'pages', 'steps_count', 'layout_around', 'imposed_file_path',
                                    'imposition_created_at', 'created_at'
                                ];
                                if (skipFields.includes(key) || value === null || value === undefined) return null;
                                
                                return (
                                    <div key={key} style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: 'var(--spacing-xs)',
                                        padding: 'var(--spacing-sm)',
                                        background: 'rgba(255, 255, 255, 0.03)',
                                        border: '1px solid rgba(255, 255, 255, 0.05)',
                                        borderRadius: 'var(--radius-sm)',
                                    }}>
                                        <div style={{
                                            width: '24px',
                                            height: '24px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: 'rgba(99, 102, 241, 0.15)',
                                            borderRadius: 'var(--radius-xs)',
                                            color: 'var(--accent-primary)',
                                            flexShrink: 0,
                                        }}>
                                            {key === 'explanation' ? <FileText size={14} /> : <Hash size={14} />}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{
                                                fontSize: '0.75rem',
                                                color: 'var(--text-secondary)',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.05em',
                                                marginBottom: 'var(--spacing-xs)',
                                            }}>
                                                {key.replace(/_/g, ' ')}
                                            </div>
                                            <div style={{
                                                fontSize: '0.875rem',
                                                fontWeight: 500,
                                                color: 'var(--text-primary)',
                                                wordBreak: 'break-word',
                                                whiteSpace: key === 'explanation' ? 'pre-wrap' : 'normal',
                                            }}>
                                                {String(value)}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                ) : (
                    <div style={{
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-tertiary)',
                        textAlign: 'center',
                    }}>
                        <FileText size={48} style={{ opacity: 0.3, marginBottom: 'var(--spacing-md)' }} />
                        <div style={{ fontSize: '0.875rem' }}>No imposition selected</div>
                    </div>
                )}
            </div>
        </div>
    );
}

