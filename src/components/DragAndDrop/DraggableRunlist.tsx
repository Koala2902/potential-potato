import { useDraggable } from '@dnd-kit/core';
import { ProductionQueueItem } from '../../types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import './DragAndDrop.css';

interface DraggableRunlistProps {
    runlist: ProductionQueueItem;
    isExpanded: boolean;
    onToggle: () => void;
    children?: React.ReactNode;
}

export default function DraggableRunlist({
    runlist,
    isExpanded,
    onToggle,
    children,
}: DraggableRunlistProps) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: `runlist-${runlist.runlist_id}`,
        data: {
            type: 'runlist',
            runlist,
        },
    });

    const style = transform
        ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          }
        : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`draggable-runlist ${isDragging ? 'dragging' : ''}`}
        >
            <div
                className="runlist-header"
                {...listeners}
                {...attributes}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
            >
                <div className="runlist-toggle">
                    {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </div>
                <div className="runlist-info">
                    <div className="runlist-id">{runlist.runlist_id}</div>
                    <div className="runlist-count">
                        {runlist.imposition_count} {runlist.imposition_count === 1 ? 'job' : 'jobs'}
                    </div>
                </div>
            </div>
            {children && <div className="runlist-children">{children}</div>}
        </div>
    );
}

