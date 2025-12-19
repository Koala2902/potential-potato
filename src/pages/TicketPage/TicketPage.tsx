import { useState, useEffect, useRef } from 'react';
import ProductionQueueList from '../../components/LeftPanel/ProductionQueueList';
import ImpositionViewer from '../../components/MiddlePanel/ImpositionViewer';
import ProductionInfo from '../../components/RightPanel/ProductionInfo';
import { ProductionQueueItem, ImpositionItem, ImpositionDetails } from '../../types';
import { fetchProductionQueue, fetchImpositionDetails, fetchFileIds, processScan } from '../../services/api';

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

    // Fetch production queue on mount - but wait for scan
    useEffect(() => {
        // Don't load all runlists initially - wait for scan
        setLoading(false);
    }, []);

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

            // Process scan and get filtered runlist
            const { runlistId, queue: filteredQueue } = await processScan(scanInput.trim());
            
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

