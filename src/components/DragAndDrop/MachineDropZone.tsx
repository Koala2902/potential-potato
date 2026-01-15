import { useDroppable } from '@dnd-kit/core';
import { Factory } from 'lucide-react';
import './DragAndDrop.css';

interface Machine {
    id: string;
    name: string;
    code: string;
    type: string;
    status: 'active' | 'maintenance' | 'inactive';
}

interface MachineDropZoneProps {
    machine: Machine;
    children: React.ReactNode;
}

export default function MachineDropZone({ machine, children }: MachineDropZoneProps) {
    const { isOver, setNodeRef } = useDroppable({
        id: `machine-${machine.id}`,
        data: {
            type: 'machine',
            machine,
        },
    });

    return (
        <div
            ref={setNodeRef}
            className={`machine-drop-zone ${isOver ? 'drag-over' : ''}`}
        >
            <div className="machine-drop-header">
                <div className="machine-drop-icon">
                    <Factory size={20} />
                </div>
                <div className="machine-drop-info">
                    <div className="machine-drop-name">{machine.name}</div>
                    <div className="machine-drop-code">{machine.code}</div>
                </div>
                {machine.status === 'maintenance' && (
                    <div className="machine-status-badge">Maintenance</div>
                )}
            </div>
            <div className="machine-drop-content">
                {children}
            </div>
            {isOver && (
                <div className="drop-indicator">
                    Drop here to assign to {machine.name}
                </div>
            )}
        </div>
    );
}

