import { useState, useEffect } from 'react';
import ProductionQueueList from '../../components/LeftPanel/ProductionQueueList';
import ImpositionViewer from '../../components/MiddlePanel/ImpositionViewer';
import ProductionInfo from '../../components/RightPanel/ProductionInfo';
import { ProductionQueueItem, ImpositionItem, ImpositionDetails } from '../../types';
import { fetchProductionQueue, fetchImpositionDetails, fetchFileId } from '../../services/api';

export default function TicketPage() {
    const [queue, setQueue] = useState<ProductionQueueItem[]>([]);
    const [selectedImposition, setSelectedImposition] = useState<ImpositionItem | null>(null);
    const [impositionDetails, setImpositionDetails] = useState<ImpositionDetails | null>(null);
    const [fileId, setFileId] = useState<string | null>(null);
    const [expandedRunlists, setExpandedRunlists] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Fetch production queue on mount
    useEffect(() => {
        loadProductionQueue();
    }, []);

    // Fetch details when imposition is selected
    useEffect(() => {
        if (selectedImposition) {
            loadImpositionDetails(selectedImposition.imposition_id);
        } else {
            setImpositionDetails(null);
            setFileId(null);
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
            const [details, id] = await Promise.all([
                fetchImpositionDetails(impositionId),
                fetchFileId(impositionId),
            ]);
            setImpositionDetails(details);
            setFileId(id);
        } catch (err) {
            console.error('Error loading imposition details:', err);
            setImpositionDetails(null);
            setFileId(null);
        }
    };

    const handleSelectImposition = (imposition: ImpositionItem, runlistId: string) => {
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

    // Handle barcode scanning (Enter key)
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            // Listen for Enter key to simulate a barcode scan
            if (e.key === 'Enter' && selectedImposition) {
                // Could add scan logic here if needed
                console.log('Scanned:', selectedImposition.imposition_id);
            }
        };

        window.addEventListener('keypress', handleKeyPress);
        return () => window.removeEventListener('keypress', handleKeyPress);
    }, [selectedImposition]);

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
                    fileId={fileId}
                />
            </div>

            <div className="right-panel">
                <ProductionInfo job={null} />
            </div>
        </div>
    );
}

