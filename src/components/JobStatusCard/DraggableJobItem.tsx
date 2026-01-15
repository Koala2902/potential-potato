import { useDraggable } from '@dnd-kit/core';
import { memo } from 'react';
import { Job } from '../../types';
import './DraggableJobItem.css';

interface DraggableJobItemProps {
    job: Job;
    isGreyedOut?: boolean;
    isProductionFinished?: boolean;
    formatDateShort: (dateString: string) => string;
    formatDateTime: (dateString: string) => string;
}

const DraggableJobItem = memo(function DraggableJobItem({
    job,
    isGreyedOut = false,
    isProductionFinished = false,
    formatDateShort,
    formatDateTime,
}: DraggableJobItemProps) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: job.id,
        data: {
            type: 'job',
            job,
        },
    });

    const totalVersions = job.totalVersions || 0;
    const completedVersions = job.completedVersions || 0;
    const percentage = totalVersions > 0 ? (completedVersions / totalVersions) * 100 : 0;
    const isComplete = totalVersions > 0 && completedVersions === totalVersions;

    const style = transform
        ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          }
        : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...listeners}
            {...attributes}
            className={`draggable-job-item ${isGreyedOut ? 'job-item-greyed' : ''} ${isDragging ? 'dragging' : ''}`}
        >
            <div className="job-item-line">
                <span className="job-id">{job.jobCode}</span>
                {totalVersions > 1 && (
                    <div className={`version-indicator ${isComplete ? 'complete' : ''}`}>
                        {isComplete ? (
                            <span className="version-text">{completedVersions}</span>
                        ) : (
                            <>
                                <svg className="version-ring" viewBox="0 0 36 36">
                                    <circle
                                        className="version-ring-bg"
                                        cx="18"
                                        cy="18"
                                        r="16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                    />
                                    <circle
                                        className="version-ring-progress"
                                        cx="18"
                                        cy="18"
                                        r="16"
                                        fill="none"
                                        stroke="var(--accent-primary)"
                                        strokeWidth="2"
                                        strokeDasharray={`${(percentage / 100) * 100.53}, 100.53`}
                                        strokeDashoffset="0"
                                        strokeLinecap="round"
                                        transform="rotate(-90 18 18)"
                                    />
                                </svg>
                                <span className="version-text">{completedVersions}/{totalVersions}</span>
                            </>
                        )}
                    </div>
                )}
                <span className="job-date-separator">•</span>
                {isProductionFinished && job.completedAt ? (
                    <>
                        <span className="job-finished-date">Finished: {formatDateTime(job.completedAt)}</span>
                        <span className="job-date-separator">•</span>
                        <span className="job-due-date">Due: {formatDateShort(job.dueDate)}</span>
                    </>
                ) : (
                    <>
                        <span className="job-order-date">Order: {formatDateShort(job.createdAt)}</span>
                        <span className="job-date-separator">•</span>
                        <span className="job-due-date">Due: {formatDateShort(job.dueDate)}</span>
                    </>
                )}
            </div>
        </div>
    );
});

export default DraggableJobItem;
