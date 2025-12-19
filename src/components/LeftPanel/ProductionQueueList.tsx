import { ProductionQueueItem, ImpositionItem } from '../../types';
import { Package, ChevronDown, ChevronRight } from 'lucide-react';
import './ProductionQueueList.css';

interface ProductionQueueListProps {
    queue: ProductionQueueItem[];
    selectedImpositionId: string | null;
    onSelectImposition: (imposition: ImpositionItem, runlistId: string) => void;
    expandedRunlists: Set<string>;
    onToggleRunlist: (runlistId: string) => void;
}

export default function ProductionQueueList({
    queue,
    selectedImpositionId,
    onSelectImposition,
    expandedRunlists,
    onToggleRunlist,
}: ProductionQueueListProps) {
    return (
        <div className="production-queue-list">
            <div className="queue-header">
                <h2 className="gradient-text">Production Queue</h2>
                <div className="queue-count">
                    {queue.reduce((sum, item) => sum + item.imposition_count, 0)} jobs
                </div>
            </div>

            <div className="queue-content">
                {queue.length === 0 ? (
                    <div className="empty-queue">
                        <Package size={48} />
                        <p>No jobs in production queue</p>
                    </div>
                ) : (
                    queue.map((item) => {
                        const isExpanded = expandedRunlists.has(item.runlist_id);

                        return (
                            <div key={item.runlist_id} className="runlist-group">
                                <div
                                    className="runlist-header"
                                    onClick={() => onToggleRunlist(item.runlist_id)}
                                >
                                    <div className="runlist-toggle">
                                        {isExpanded ? (
                                            <ChevronDown size={18} />
                                        ) : (
                                            <ChevronRight size={18} />
                                        )}
                                    </div>
                                    <div className="runlist-info">
                                        <div className="runlist-id">{item.runlist_id}</div>
                                        <div className="runlist-count">
                                            {item.imposition_count} {item.imposition_count === 1 ? 'imposition' : 'impositions'}
                                        </div>
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="impositions-list">
                                        {item.impositions.map((imposition) => {
                                            const isSelected =
                                                selectedImpositionId === imposition.imposition_id;

                                            return (
                                                <div
                                                    key={imposition.imposition_id}
                                                    className={`imposition-item ${isSelected ? 'active' : ''}`}
                                                    onClick={() =>
                                                        onSelectImposition(imposition, item.runlist_id)
                                                    }
                                                >
                                                    <div className="imposition-name">
                                                        {imposition.simplified_name}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

