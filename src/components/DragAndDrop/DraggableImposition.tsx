import { useDraggable } from '@dnd-kit/core';
import { ImpositionItem } from '../../types';
import './DragAndDrop.css';

interface DraggableImpositionProps {
    imposition: ImpositionItem;
    runlistId: string;
    isSelected: boolean;
    onClick: () => void;
}

export default function DraggableImposition({
    imposition,
    runlistId,
    isSelected,
    onClick,
}: DraggableImpositionProps) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: `imposition-${imposition.imposition_id}`,
        data: {
            type: 'imposition',
            imposition,
            runlistId,
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
            {...listeners}
            {...attributes}
            className={`draggable-imposition ${isSelected ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
            onClick={onClick}
        >
            <div className="imposition-name">{imposition.simplified_name}</div>
            <div className="imposition-id">{imposition.imposition_id}</div>
        </div>
    );
}

