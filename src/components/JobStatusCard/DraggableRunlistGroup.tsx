import { useDraggable } from '@dnd-kit/core';
import { memo } from 'react';
import { GroupedJobs } from '../../types';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import './DraggableRunlistGroup.css';

interface DraggableRunlistGroupProps {
    group: GroupedJobs;
    isExpanded: boolean;
    onToggle: () => void;
    isRunlistGroup: boolean;
    formatGroupKey: (key: string) => string;
    getMaxStatus: (jobs: any[]) => number;
    statusNames: Record<number, string>;
    processedJobs: number;
    totalJobs: number;
    progressPercentage: number;
    totalQty: number;
}

const DraggableRunlistGroup = memo(function DraggableRunlistGroup({
    group,
    isExpanded,
    onToggle,
    isRunlistGroup,
    formatGroupKey,
    getMaxStatus,
    statusNames,
    processedJobs,
    totalJobs,
    progressPercentage,
    totalQty,
}: DraggableRunlistGroupProps) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: `runlist-${group.groupKey}`,
        data: {
            type: 'runlist',
            runlistId: group.groupKey,
            jobs: group.jobs,
        },
    });

    const style = transform
        ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          }
        : undefined;

    const maxStatus = getMaxStatus(group.jobs);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`draggable-runlist-group ${isDragging ? 'dragging' : ''}`}
        >
            <div className="group-header" onClick={onToggle}>
                <div className="group-toggle">
                    {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </div>
                {isRunlistGroup && (
                    <div className="group-progress-ring">
                        {progressPercentage === 100 ? (
                            <div className="progress-ring-complete">
                                <span>{processedJobs}</span>
                            </div>
                        ) : (
                            <>
                                <svg className="progress-ring" viewBox="0 0 36 36">
                                    <circle
                                        className="progress-ring-bg"
                                        cx="18"
                                        cy="18"
                                        r="16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    />
                                    <circle
                                        className="progress-ring-progress"
                                        cx="18"
                                        cy="18"
                                        r="16"
                                        fill="none"
                                        stroke="var(--accent-primary)"
                                        strokeWidth="2"
                                        strokeDasharray={`${(progressPercentage / 100) * 100.53}, 100.53`}
                                        strokeDashoffset="0"
                                        strokeLinecap="round"
                                        transform="rotate(-90 18 18)"
                                    />
                                </svg>
                                <span className="progress-text">{processedJobs}/{totalJobs}</span>
                            </>
                        )}
                    </div>
                )}
                <div className="group-info">
                    <div className="group-name">
                        {isRunlistGroup ? `Runlist ${formatGroupKey(group.groupKey)}` : formatGroupKey(group.groupKey)}
                        {isRunlistGroup && maxStatus > 1 && (
                            <span className="group-status-badge">{statusNames[maxStatus]}</span>
                        )}
                    </div>
                    <div className="group-meta">
                        {group.jobs.length} {group.jobs.length === 1 ? 'job' : 'jobs'} • {totalQty.toLocaleString()} units
                    </div>
                </div>
                <div 
                    className="group-drag-handle"
                    {...listeners}
                    {...attributes}
                    onClick={(e) => {
                        e.stopPropagation();
                    }}
                    onMouseDown={(e) => {
                        // Allow drag to start but prevent toggle
                        e.stopPropagation();
                    }}
                >
                    <GripVertical size={16} />
                </div>
            </div>
        </div>
    );
});

export default DraggableRunlistGroup;
