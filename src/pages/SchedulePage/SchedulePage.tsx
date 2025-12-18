import { useState, useMemo } from 'react';
import { Calendar, ChevronLeft, ChevronRight, CheckSquare, Square } from 'lucide-react';
import DailyView from './components/DailyView';
import WeeklyView from './components/WeeklyView';
import MonthlyView from './components/MonthlyView';
import { mockMachines } from '../../data/scheduleData';
import { mockScheduledJobs } from '../../data/scheduleData';
import { Machine } from '../../types';
import './SchedulePage.css';

type ViewType = 'daily' | 'weekly' | 'monthly';

export default function SchedulePage() {
    const [viewType, setViewType] = useState<ViewType>('daily');
    const [currentDate, setCurrentDate] = useState(new Date());
    const [selectedMachines, setSelectedMachines] = useState<string[]>(
        mockMachines.filter((m) => m.status === 'active').map((m) => m.id)
    );

    const machines = mockMachines;
    const scheduledJobs = mockScheduledJobs;

    const handleSelectAll = () => {
        if (selectedMachines.length === machines.length) {
            setSelectedMachines([]);
        } else {
            setSelectedMachines(machines.map((m) => m.id));
        }
    };

    const handleMachineToggle = (machineId: string) => {
        setSelectedMachines((prev) =>
            prev.includes(machineId)
                ? prev.filter((id) => id !== machineId)
                : [...prev, machineId]
        );
    };

    const navigateDate = (direction: 'prev' | 'next') => {
        const newDate = new Date(currentDate);
        if (viewType === 'daily') {
            newDate.setDate(newDate.getDate() + (direction === 'next' ? 1 : -1));
        } else if (viewType === 'weekly') {
            newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
        } else if (viewType === 'monthly') {
            newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1));
        }
        setCurrentDate(newDate);
    };

    const getDateDisplay = () => {
        if (viewType === 'daily') {
            return currentDate.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
            });
        } else if (viewType === 'weekly') {
            const weekStart = new Date(currentDate);
            const day = weekStart.getDay();
            const diff = weekStart.getDate() - day + (day === 0 ? -6 : 1);
            weekStart.setDate(diff);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);
            return `${weekStart.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
            })} - ${weekEnd.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            })}`;
        } else {
            return currentDate.toLocaleDateString('en-US', {
                month: 'long',
                year: 'numeric',
            });
        }
    };

    const allSelected = selectedMachines.length === machines.length;

    return (
        <div className="schedule-page">
            <div className="schedule-header">
                <div className="schedule-title">
                    <Calendar size={24} />
                    <h2>Production Schedule</h2>
                </div>
            </div>

            <div className="schedule-controls">
                <div className="view-switcher">
                    <button
                        className={`view-btn ${viewType === 'daily' ? 'active' : ''}`}
                        onClick={() => setViewType('daily')}
                    >
                        Daily
                    </button>
                    <button
                        className={`view-btn ${viewType === 'weekly' ? 'active' : ''}`}
                        onClick={() => setViewType('weekly')}
                    >
                        Weekly
                    </button>
                    <button
                        className={`view-btn ${viewType === 'monthly' ? 'active' : ''}`}
                        onClick={() => setViewType('monthly')}
                    >
                        Monthly
                    </button>
                </div>

                <div className="date-navigation">
                    <button
                        className="nav-btn"
                        onClick={() => navigateDate('prev')}
                        title="Previous"
                    >
                        <ChevronLeft size={20} />
                    </button>
                    <div className="current-date">{getDateDisplay()}</div>
                    <button
                        className="nav-btn"
                        onClick={() => navigateDate('next')}
                        title="Next"
                    >
                        <ChevronRight size={20} />
                    </button>
                    <button
                        className="nav-btn today-btn"
                        onClick={() => setCurrentDate(new Date())}
                    >
                        Today
                    </button>
                </div>
            </div>

            <div className="machine-selection">
                <button
                    className="select-all-btn"
                    onClick={handleSelectAll}
                    title={allSelected ? 'Deselect All' : 'Select All'}
                >
                    {allSelected ? <CheckSquare size={18} /> : <Square size={18} />}
                    <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
                </button>
                <div className="machine-checkboxes">
                    {machines.map((machine) => (
                        <label
                            key={machine.id}
                            className={`machine-checkbox ${
                                machine.status !== 'active' ? 'inactive' : ''
                            }`}
                        >
                            <input
                                type="checkbox"
                                checked={selectedMachines.includes(machine.id)}
                                onChange={() => handleMachineToggle(machine.id)}
                                disabled={machine.status !== 'active'}
                            />
                            <span className="machine-checkbox-label">
                                {machine.name} ({machine.code})
                            </span>
                            {machine.status === 'maintenance' && (
                                <span className="machine-status-badge">Maintenance</span>
                            )}
                        </label>
                    ))}
                </div>
            </div>

            <div className="schedule-content">
                {viewType === 'daily' && (
                    <DailyView
                        date={currentDate}
                        machines={machines}
                        selectedMachines={selectedMachines}
                        scheduledJobs={scheduledJobs}
                        startHour={8}
                        endHour={17}
                        endMinute={30}
                    />
                )}
                {viewType === 'weekly' && (
                    <WeeklyView
                        startDate={currentDate}
                        machines={machines}
                        selectedMachines={selectedMachines}
                        scheduledJobs={scheduledJobs}
                    />
                )}
                {viewType === 'monthly' && (
                    <MonthlyView
                        month={currentDate}
                        machines={machines}
                        selectedMachines={selectedMachines}
                        scheduledJobs={scheduledJobs}
                    />
                )}
            </div>
        </div>
    );
}

