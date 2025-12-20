import { useState, useEffect, useRef } from 'react';
import ProductionQueueList from '../../components/LeftPanel/ProductionQueueList';
import ImpositionViewer from '../../components/MiddlePanel/ImpositionViewer';
import ProductionInfo from '../../components/RightPanel/ProductionInfo';
import { ProductionQueueItem, ImpositionItem, ImpositionDetails } from '../../types';
import { fetchProductionQueue, fetchImpositionDetails, fetchFileIds, processScan, fetchMachines, fetchOperations, Machine, Operation } from '../../services/api';
import { Settings, ChevronDown } from 'lucide-react';

export default function TicketPage() {
    const [queue, setQueue] = useState<ProductionQueueItem[]>([]);
    const [selectedImposition, setSelectedImposition] = useState<ImpositionItem | null>(null);
    const [impositionDetails, setImpositionDetails] = useState<ImpositionDetails | null>(null);
    const [fileIds, setFileIds] = useState<string[]>([]);
    const [expandedRunlists, setExpandedRunlists] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [scanInput, setScanInput] = useState<string>('');
    const [isScanning, setIsScanning] = useState(false);
    const scanInputRef = useRef<HTMLInputElement>(null);
    
    // Machine and operation selection
    const [machines, setMachines] = useState<Machine[]>([]);
    const [operations, setOperations] = useState<Operation[]>([]);
    const [selectedMachineId, setSelectedMachineId] = useState<string>('');
    const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
    const [selectedOperations, setSelectedOperations] = useState<string[]>([]); // Array of operation_ids
    const [showSettings, setShowSettings] = useState(false);

    // Fetch machines on mount
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
        setLoading(false);
    }, []);

    // Update operations when machine selection changes
    useEffect(() => {
        const loadOperations = async () => {
            if (selectedMachine) {
                try {
                    const operationsData = await fetchOperations(selectedMachine.machine_id);
                    setOperations(operationsData);
                    // Reset operation selection - only keep operations that are still available
                    const availableOperationIds = operationsData.map(op => op.operation_id);
                    setSelectedOperations(prev => prev.filter(opId => availableOperationIds.includes(opId)));
                } catch (err) {
                    console.error('Error loading operations:', err);
                }
            } else {
                setOperations([]);
                setSelectedOperations([]);
            }
        };
        loadOperations();
    }, [selectedMachine]);

    // Focus scan input on mount
    useEffect(() => {
        scanInputRef.current?.focus();
    }, []);

    // Fetch details when imposition is selected
    useEffect(() => {
        if (selectedImposition) {
            loadImpositionDetails(selectedImposition.imposition_id);
        } else {
            setImpositionDetails(null);
            setFileIds([]);
        }
    }, [selectedImposition]);

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

    // Handle scan input
    const handleScanSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!scanInput.trim() || isScanning) {
            return;
        }

        try {
            setIsScanning(true);
            setError(null);
            setLoading(true);

            // Process scan and get filtered runlist (with machine and operations if selected)
            const { runlistId, queue: filteredQueue } = await processScan(
                scanInput.trim(),
                selectedMachineId || null,
                selectedOperations.length > 0 ? selectedOperations : null
            );
            
            setQueue(filteredQueue);
            
            // Expand the runlist automatically
            if (filteredQueue.length > 0) {
                setExpandedRunlists(new Set([runlistId]));
            }

            // Clear scan input
            setScanInput('');
            scanInputRef.current?.focus();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to process scan');
            console.error('Error processing scan:', err);
        } finally {
            setIsScanning(false);
            setLoading(false);
        }
    };

    // Handle scan input change (for barcode scanners that auto-submit)
    const handleScanInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setScanInput(value);
        
        // Auto-submit if Enter key was pressed (barcode scanner behavior)
        // This will be handled by form submit
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
                                        const machineId = e.target.value;
                                        setSelectedMachineId(machineId);
                                        const machine = machines.find(m => m.machine_id === machineId) || null;
                                        setSelectedMachine(machine);
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
                                    }}
                                >
                                    <option value="">Select Machine</option>
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
                                                        {op.can_run_parallel && (
                                                            <span style={{
                                                                fontSize: '0.75rem',
                                                                color: 'var(--text-tertiary)',
                                                                marginLeft: 'var(--spacing-xs)',
                                                            }}>
                                                                (parallel)
                                                            </span>
                                                        )}
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

                {/* Scan Input */}
                <div className="scan-input-container" style={{ padding: 'var(--spacing-md)', borderBottom: '1px solid var(--border-color)' }}>
                    <form onSubmit={handleScanSubmit}>
                        <input
                            ref={scanInputRef}
                            type="text"
                            value={scanInput}
                            onChange={handleScanInputChange}
                            placeholder="Scan barcode (job_id_version_tag)..."
                            disabled={isScanning}
                            style={{
                                width: '100%',
                                padding: 'var(--spacing-sm) var(--spacing-md)',
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-primary)',
                                fontSize: '0.875rem',
                            }}
                        />
                    </form>
                </div>
                <ProductionQueueList
                    queue={queue}
                    selectedImpositionId={selectedImposition?.imposition_id || null}
                    onSelectImposition={handleSelectImposition}
                    expandedRunlists={expandedRunlists}
                    onToggleRunlist={handleToggleRunlist}
                />
            </div>

            <div className="middle-panel">
                <ImpositionViewer
                    imposition={selectedImposition}
                    details={impositionDetails}
                    fileIds={fileIds}
                />
            </div>

            <div className="right-panel">
                <ProductionInfo job={null} />
            </div>
        </div>
    );
}

