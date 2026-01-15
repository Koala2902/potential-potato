import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    DndContext,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    PointerSensor,
    useSensor,
    useSensors,
    closestCenter,
} from '@dnd-kit/core';
import { Job, JobStatusCategory, JobStatusCardConfig } from '../../types';
import { fetchJobs } from '../../services/api';
import JobStatusCard from '../../components/JobStatusCard/JobStatusCard';
import { Loader2 } from 'lucide-react';
import './JobStatusPage.css';

// Status column configurations
const statusConfigs: JobStatusCardConfig[] = [
    {
        status: 'print_ready',
        filterRule: (job: Job) => job.currentStatus === 'print_ready' || !job.currentStatus,
        groupBy: 'runlist',
        sortBy: 'due_date',
        title: 'Print Ready',
        description: 'Jobs ready for printing',
        icon: 'Package',
    },
    {
        status: 'printed',
        filterRule: (job: Job) => job.currentStatus === 'printed',
        groupBy: 'runlist',
        sortBy: 'due_date',
        title: 'Printed',
        description: 'Jobs that have been printed',
        icon: 'Printer',
    },
    {
        status: 'digital_cut',
        filterRule: (job: Job) => job.currentStatus === 'digital_cut',
        groupBy: 'runlist',
        sortBy: 'due_date',
        title: 'Digital Cut',
        description: 'Jobs at digital cutting stage',
        icon: 'Scissors',
    },
    {
        status: 'slitter',
        filterRule: (job: Job) => job.currentStatus === 'slitter',
        groupBy: 'runlist',
        sortBy: 'due_date',
        title: 'Slitter',
        description: 'Jobs at slitter stage',
        icon: 'Scissors',
    },
    {
        status: 'production_finished',
        filterRule: (job: Job) => job.currentStatus === 'production_finished',
        groupBy: 'runlist',
        sortBy: 'due_date',
        title: 'Production Finished',
        description: 'Completed production jobs',
        icon: 'CheckCircle2',
    },
];

export default function JobStatusPage() {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draggedJob, setDraggedJob] = useState<Job | null>(null);
    const [draggedRunlist, setDraggedRunlist] = useState<{ runlistId: string; jobs: Job[] } | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        })
    );

    // Memoize status configs to prevent recreation
    const memoizedStatusConfigs = useMemo(() => statusConfigs, []);

    useEffect(() => {
        loadJobs();
    }, []);

    const loadJobs = async () => {
        try {
            setLoading(true);
            setError(null);
            const jobsData = await fetchJobs({ limit: 1000 });
            
            // Transform API data to match Job interface
            const transformedJobs: Job[] = jobsData.map((job: any) => {
                // Map status from API format to JobStatusCategory
                let currentStatus: JobStatusCategory = 'print_ready';
                if (job.status) {
                    const statusMap: Record<string, JobStatusCategory> = {
                        'print_ready': 'print_ready',
                        'printed': 'printed',
                        'digital_cut': 'digital_cut',
                        'slitter': 'slitter',
                        'production_finished': 'production_finished',
                    };
                    currentStatus = statusMap[job.status] || 'print_ready';
                }
                
                // Format job_id as jobCode (use job_id directly, e.g., "4677_5995")
                const jobId = job.job_id || job.id || '';
                const jobCode = jobId;
                
                // Handle dates - API returns created_at and updated_at
                // If dates are null/invalid, use current date as fallback
                let createdAt: string;
                let dueDate: string;
                
                if (job.created_at) {
                    const createdDate = new Date(job.created_at);
                    if (!isNaN(createdDate.getTime())) {
                        createdAt = createdDate.toISOString();
                        // Due date: add 7 days to created_at
                        const due = new Date(createdDate);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    } else {
                        // Invalid date, use current date
                        const now = new Date();
                        createdAt = now.toISOString();
                        const due = new Date(now);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    }
                } else if (job.updated_at) {
                    // Fallback to updated_at if created_at is missing
                    const updatedDate = new Date(job.updated_at);
                    if (!isNaN(updatedDate.getTime())) {
                        createdAt = updatedDate.toISOString();
                        const due = new Date(updatedDate);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    } else {
                        const now = new Date();
                        createdAt = now.toISOString();
                        const due = new Date(now);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    }
                } else {
                    // No dates available, use current date
                    const now = new Date();
                    createdAt = now.toISOString();
                    const due = new Date(now);
                    due.setDate(due.getDate() + 7);
                    dueDate = due.toISOString();
                }
                
                return {
                    id: jobId,
                    jobCode: jobCode,
                    rollId: job.runlist_id || '',
                    orderId: jobId,
                    ticketId: jobId,
                    versionTag: job.version_tags?.[0] || '',
                    versionQty: job.total_versions || 0,
                    pdfPath: '',
                    status: 'pending' as const,
                    dueDate: dueDate,
                    comments: '',
                    qtyExplanation: '',
                    positionInRoll: 0,
                    createdAt: createdAt,
                    currentStatus: currentStatus,
                    totalVersions: job.total_versions || 0,
                    completedVersions: job.completed_versions || 0,
                    versionTags: job.version_tags || [],
                    runlistId: job.runlist_id || null,
                };
            });
            
            setJobs(transformedJobs);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load jobs');
            console.error('Error loading jobs:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        const activeId = event.active.id as string;
        const activeData = event.active.data.current;
        setActiveId(activeId);
        
        // Check if it's a runlist or a job
        if (activeId.startsWith('runlist-') && activeData?.type === 'runlist') {
            // It's a runlist
            setDraggedJob(null);
            setDraggedRunlist({
                runlistId: activeData.runlistId,
                jobs: activeData.jobs || [],
            });
        } else {
            // It's a job
            setDraggedRunlist(null);
            const job = jobs.find((j) => j.id === activeId) || activeData?.job;
            if (job) {
                setDraggedJob(job);
            }
        }
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        
        // Always clear active state first to prevent blank screen
        setActiveId(null);
        setDraggedJob(null);
        setDraggedRunlist(null);

        if (!over) return;

        try {
            const activeId = active.id as string;
            const targetStatus = over.id as string;

            // Check if dropped on a status column
            if (statusConfigs.some((config) => config.status === targetStatus)) {
                const activeData = active.data.current;
                
                // Check if it's a runlist group
                if (activeId.startsWith('runlist-') && activeData?.type === 'runlist') {
                    const runlistId = activeData.runlistId;
                    const runlistJobs = activeData.jobs || [];
                    
                    if (runlistJobs.length > 0) {
                        // Don't await - run in background to prevent blocking
                        updateRunlistStatus(runlistId, runlistJobs, targetStatus as JobStatusCategory).catch(err => {
                            console.error('Error updating runlist status:', err);
                        });
                    } else {
                        console.warn(`No jobs found in runlist ${runlistId}`);
                    }
                } 
                // Otherwise it's an individual job
                else {
                    const job = jobs.find((j) => j.id === activeId);
                    if (job && job.currentStatus !== targetStatus) {
                        // Don't await - run in background to prevent blocking
                        updateJobStatus(activeId, targetStatus as JobStatusCategory).catch(err => {
                            console.error('Error updating job status:', err);
                        });
                    }
                }
            }
        } catch (err) {
            console.error('Error in handleDragEnd:', err);
            // Don't set error state to avoid blank screen
        }
    };

    const updateJobStatus = async (jobId: string, newStatus: JobStatusCategory) => {
        try {
            // Optimistically update UI (don't show full loading screen)
            setJobs((prevJobs) =>
                prevJobs.map((job) =>
                    job.id === jobId ? { ...job, currentStatus: newStatus } : job
                )
            );
            
            // Call API to update status (creates scanned codes)
            const response = await fetch(`/api/jobs/${jobId}/status`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ status: newStatus }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Failed to update job status' }));
                throw new Error(errorData.error || 'Failed to update job status');
            }

            const result = await response.json();
            console.log('Status update result:', result);

            // Process scanned codes in background (don't wait)
            fetch('/api/process-status-updates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'scanner' }),
            }).catch(err => console.warn('Background processing failed:', err));

            // Reload jobs after a short delay (allows processing to complete, without loading screen)
            setTimeout(() => {
                loadJobsWithoutLoadingScreen().catch(err => console.error('Error reloading jobs:', err));
            }, 500);
        } catch (err) {
            console.error('Error updating job status:', err);
            // Don't set error state - just log it to avoid blank screen
            // Reload jobs to revert optimistic update (without loading screen)
            loadJobsWithoutLoadingScreen().catch(reloadErr => 
                console.error('Error reloading jobs:', reloadErr)
            );
        }
    };

    const updateRunlistStatus = async (runlistId: string, runlistJobs: Job[], newStatus: JobStatusCategory) => {
        try {
            // Optimistically update UI for all jobs in runlist (don't set loading)
            setJobs((prevJobs) =>
                prevJobs.map((job) =>
                    runlistJobs.some((rj) => rj.id === job.id) 
                        ? { ...job, currentStatus: newStatus } 
                        : job
                )
            );
            
            // Use the runlist endpoint (more efficient - updates all jobs at once)
            const response = await fetch(`/api/runlists/${runlistId}/status`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ status: newStatus }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Failed to update runlist status' }));
                throw new Error(errorData.error || 'Failed to update runlist status');
            }

            const result = await response.json();
            console.log(`Updated runlist ${runlistId}:`, result);

            // Process scanned codes in background (don't wait)
            fetch('/api/process-status-updates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'scanner' }),
            }).catch(err => console.warn('Background processing failed:', err));

            // Reload jobs after a short delay (without showing loading screen)
            setTimeout(() => {
                loadJobsWithoutLoadingScreen().catch(err => console.error('Error reloading jobs:', err));
            }, 500);
        } catch (err) {
            console.error('Error updating runlist status:', err);
            // Don't set error state - just log it to avoid blank screen
            // Reload jobs to revert optimistic update (without loading screen)
            loadJobsWithoutLoadingScreen().catch(reloadErr => 
                console.error('Error reloading jobs:', reloadErr)
            );
        }
    };

    const loadJobsWithoutLoadingScreen = async () => {
        try {
            setError(null);
            const jobsData = await fetchJobs({ limit: 1000 });
            
            // Transform API data to match Job interface (same as loadJobs but without setLoading)
            const transformedJobs: Job[] = jobsData.map((job: any) => {
                let currentStatus: JobStatusCategory = 'print_ready';
                if (job.status) {
                    const statusMap: Record<string, JobStatusCategory> = {
                        'print_ready': 'print_ready',
                        'printed': 'printed',
                        'digital_cut': 'digital_cut',
                        'slitter': 'slitter',
                        'production_finished': 'production_finished',
                    };
                    currentStatus = statusMap[job.status] || 'print_ready';
                }
                
                const jobId = job.job_id || job.id || '';
                const jobCode = jobId;
                
                let createdAt: string;
                let dueDate: string;
                
                if (job.created_at) {
                    const createdDate = new Date(job.created_at);
                    if (!isNaN(createdDate.getTime())) {
                        createdAt = createdDate.toISOString();
                        const due = new Date(createdDate);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    } else {
                        const now = new Date();
                        createdAt = now.toISOString();
                        const due = new Date(now);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    }
                } else if (job.updated_at) {
                    const updatedDate = new Date(job.updated_at);
                    if (!isNaN(updatedDate.getTime())) {
                        createdAt = updatedDate.toISOString();
                        const due = new Date(updatedDate);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    } else {
                        const now = new Date();
                        createdAt = now.toISOString();
                        const due = new Date(now);
                        due.setDate(due.getDate() + 7);
                        dueDate = due.toISOString();
                    }
                } else {
                    const now = new Date();
                    createdAt = now.toISOString();
                    const due = new Date(now);
                    due.setDate(due.getDate() + 7);
                    dueDate = due.toISOString();
                }
                
                return {
                    id: jobId,
                    jobCode: jobCode,
                    rollId: job.runlist_id || '',
                    orderId: jobId,
                    ticketId: jobId,
                    versionTag: job.version_tags?.[0] || '',
                    versionQty: job.total_versions || 0,
                    pdfPath: '',
                    status: 'pending' as const,
                    dueDate: dueDate,
                    comments: '',
                    qtyExplanation: '',
                    positionInRoll: 0,
                    createdAt: createdAt,
                    currentStatus: currentStatus,
                    totalVersions: job.total_versions || 0,
                    completedVersions: job.completed_versions || 0,
                    versionTags: job.version_tags || [],
                    runlistId: job.runlist_id || null,
                };
            });
            
            setJobs(transformedJobs);
        } catch (err) {
            console.error('Error reloading jobs:', err);
            // Don't set error here to avoid blank screen
        }
    };

    if (loading) {
        return (
            <div className="job-status-page">
                <div className="loading-state">
                    <Loader2 className="animate-spin" size={32} />
                    <p>Loading jobs...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="job-status-page">
                <div className="error-state">
                    <p>Error: {error}</p>
                    <button onClick={loadJobs}>Retry</button>
                </div>
            </div>
        );
    }

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            <div className="job-status-page">
                <div className="job-status-header">
                    <h1>Job Status</h1>
                    <p>Drag jobs between columns to update their status</p>
                </div>

                <div className="job-status-columns">
                    {memoizedStatusConfigs.map((config) => (
                        <div
                            key={config.status}
                            id={config.status}
                            className="status-column"
                        >
                            <JobStatusCard config={config} jobs={jobs} />
                        </div>
                    ))}
                </div>

                {/* Drag Overlay */}
                <DragOverlay>
                    {activeId && (
                        draggedRunlist ? (
                            <div className="drag-overlay-runlist">
                                <div className="runlist-id">Runlist {draggedRunlist.runlistId}</div>
                                <div className="runlist-count">
                                    {draggedRunlist.jobs.length} {draggedRunlist.jobs.length === 1 ? 'job' : 'jobs'}
                                </div>
                            </div>
                        ) : draggedJob ? (
                            <div className="drag-overlay-job">
                                <div className="job-id">{draggedJob.jobCode}</div>
                                <div className="job-status">
                                    {draggedJob.currentStatus || 'print_ready'}
                                </div>
                            </div>
                        ) : activeId.startsWith('runlist-') ? (
                            <div className="drag-overlay-runlist">
                                <div className="runlist-id">Runlist {activeId.replace('runlist-', '')}</div>
                                <div className="runlist-count">Dragging...</div>
                            </div>
                        ) : null
                    )}
                </DragOverlay>
            </div>
        </DndContext>
    );
}
