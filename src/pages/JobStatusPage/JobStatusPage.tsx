import { useState, useEffect } from 'react';
import { Activity, Settings, X } from 'lucide-react';
import { Job, JobStatusCardConfig } from '../../types';
import JobStatusCard from '../../components/JobStatusCard/JobStatusCard';
import { fetchJobs, JobFilterOptions } from '../../services/api';
import './JobStatusPage.css';

// Map database job to frontend Job interface
function mapDbJobToJob(dbJob: any): Job {
    // Map status from backend status to frontend status
    const statusMap: Record<string, 'pending' | 'started' | 'completed'> = {
        'print_ready': 'pending',
        'printed': 'started',
        'digital_cut': 'started',
        'slitter': 'started',
        'production_finished': 'completed',
    };

    return {
        id: dbJob.job_id?.toString() || '',
        jobCode: dbJob.job_id?.toString() || 'N/A',
        rollId: '',
        orderId: '',
        ticketId: '',
        versionTag: '', // Not used when grouped
        versionQty: dbJob.total_versions || 0,
        pdfPath: '',
        status: statusMap[dbJob.status] || 'pending',
        dueDate: dbJob.updated_at || dbJob.created_at || new Date().toISOString(),
        comments: '',
        qtyExplanation: `${dbJob.completed_versions || 0} of ${dbJob.total_versions || 0} versions completed`,
        positionInRoll: 0,
        createdAt: dbJob.created_at || new Date().toISOString(),
        startedAt: undefined,
        completedAt: dbJob.updated_at || undefined,
        material: '',
        finishing: '',
        operations: {}, // Not used when grouped
        // Additional fields for grouped display
        totalVersions: dbJob.total_versions || 0,
        completedVersions: dbJob.completed_versions || 0,
        versionTags: dbJob.version_tags || [],
        currentStatus: dbJob.status || 'print_ready', // Use status from database view
        maxCompletedSequence: dbJob.max_completed_sequence || 0,
        runlistId: dbJob.runlist_id || null, // Runlist ID for grouping
    };
}

export default function JobStatusPage() {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showFilters, setShowFilters] = useState(false);
    const [limit, setLimit] = useState<number>(500); // Increased limit to show more jobs across all statuses
    const [filters, setFilters] = useState<JobFilterOptions>({
        // No default filters - querying from job_operations
        limit: 500, // Request more jobs to ensure all statuses are represented
    });

    // Load jobs from API
    useEffect(() => {
        loadJobs();
    }, [filters, limit]);

    async function loadJobs() {
        setLoading(true);
        setError(null);
        try {
            // Request all jobs (or a large limit) so we can see all statuses
            const dbJobs = await fetchJobs({ ...filters, limit: limit || 500 });
            console.log('Raw jobs from API (first 5):', dbJobs.slice(0, 5).map(j => ({ 
                job_id: j.job_id, 
                status: j.status, 
                max_completed_sequence: j.max_completed_sequence 
            }))); // Debug: log first 5 jobs
            const mappedJobs = dbJobs.map(mapDbJobToJob);
            // Debug: Log status distribution
            const statusCounts = mappedJobs.reduce((acc, job) => {
                const status = job.currentStatus || 'unknown';
                acc[status] = (acc[status] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);
            console.log('Job status distribution:', statusCounts);
            setJobs(mappedJobs);
        } catch (err) {
            console.error('Error loading jobs:', err);
            setError(err instanceof Error ? err.message : 'Failed to load jobs');
        } finally {
            setLoading(false);
        }
    }

    // Define status card configurations
    const statusCardConfigs: JobStatusCardConfig[] = [
        {
            status: 'print_ready',
            title: 'Print Ready',
            description: 'All jobs without any status yet',
            icon: 'Printer',
            filterRule: (job: Job) => {
                return job.currentStatus === 'print_ready';
            },
            groupBy: 'runlist',
            sortBy: 'due_date',
        },
        {
            status: 'printed',
            title: 'Printed',
            description: 'Print operation completed',
            icon: 'Printer',
            filterRule: (job: Job) => {
                return job.currentStatus === 'printed';
            },
            groupBy: 'runlist',
            sortBy: 'due_date',
        },
        {
            status: 'digital_cut',
            title: 'Digital Cut',
            description: 'Coating operation completed',
            icon: 'Scissors',
            filterRule: (job: Job) => {
                return job.currentStatus === 'digital_cut';
            },
            groupBy: 'runlist',
            sortBy: 'due_date',
        },
        {
            status: 'slitter',
            title: 'Slitter',
            description: 'Kiss cut and backscore done, slitter pending',
            icon: 'Minus',
            filterRule: (job: Job) => {
                return job.currentStatus === 'slitter';
            },
            groupBy: 'runlist',
            sortBy: 'due_date',
        },
        {
            status: 'production_finished',
            title: 'Production Finished',
            description: 'All operations completed',
            icon: 'CheckCircle2',
            filterRule: (job: Job) => {
                return job.currentStatus === 'production_finished';
            },
            groupBy: 'runlist',
            sortBy: 'due_date',
        },
    ];

    return (
        <div className="job-status-page">
            <div className="job-status-header">
                <div className="job-status-title">
                    <Activity size={24} />
                    <h2>Job Status Overview</h2>
                </div>
                <button 
                    className="filter-toggle-btn"
                    onClick={() => setShowFilters(!showFilters)}
                >
                    <Settings size={18} />
                    Filters
                </button>
            </div>

            {showFilters && (
                <div className="filter-panel">
                    <div className="filter-panel-header">
                        <h3>Filter Jobs</h3>
                        <button 
                            className="close-filter-btn"
                            onClick={() => setShowFilters(false)}
                        >
                            <X size={18} />
                        </button>
                    </div>
                    <div className="filter-options">
                        <div className="filter-group">
                            <label>Status:</label>
                            <select
                                value={filters.status || ''}
                                onChange={(e) => setFilters({ ...filters, status: e.target.value || undefined })}
                            >
                                <option value="">All Statuses</option>
                                <option value="pending">Pending</option>
                                <option value="started">Started</option>
                                <option value="completed">Completed</option>
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Material:</label>
                            <input
                                type="text"
                                placeholder="Filter by material"
                                value={filters.material || ''}
                                onChange={(e) => setFilters({ ...filters, material: e.target.value || undefined })}
                            />
                        </div>

                        <div className="filter-group">
                            <label>Finishing:</label>
                            <input
                                type="text"
                                placeholder="Filter by finishing"
                                value={filters.finishing || ''}
                                onChange={(e) => setFilters({ ...filters, finishing: e.target.value || undefined })}
                            />
                        </div>

                        <div className="filter-group">
                            <label>Limit Results:</label>
                            <select
                                value={limit}
                                onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                            >
                                <option value={50}>50 jobs</option>
                                <option value={100}>100 jobs</option>
                                <option value={200}>200 jobs</option>
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Operations:</label>
                            <div className="filter-checkboxes">
                                <label className="filter-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={filters.hasPrint || false}
                                        onChange={(e) => setFilters({ ...filters, hasPrint: e.target.checked ? true : undefined })}
                                    />
                                    <span>Has Print</span>
                                </label>
                                <label className="filter-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={filters.hasCoating || false}
                                        onChange={(e) => setFilters({ ...filters, hasCoating: e.target.checked ? true : undefined })}
                                    />
                                    <span>Has Coating</span>
                                </label>
                                <label className="filter-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={filters.hasKissCut || false}
                                        onChange={(e) => setFilters({ ...filters, hasKissCut: e.target.checked ? true : undefined })}
                                    />
                                    <span>Has Kiss Cut</span>
                                </label>
                                <label className="filter-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={filters.hasBackscore || false}
                                        onChange={(e) => setFilters({ ...filters, hasBackscore: e.target.checked ? true : undefined })}
                                    />
                                    <span>Has Backscore</span>
                                </label>
                                <label className="filter-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={filters.hasSlitter || false}
                                        onChange={(e) => setFilters({ ...filters, hasSlitter: e.target.checked ? true : undefined })}
                                    />
                                    <span>Has Slitter</span>
                                </label>
                            </div>
                        </div>

                        <div className="filter-actions">
                            <button 
                                className="clear-filters-btn"
                                onClick={() => {
                                    setFilters({}); // Reset filters
                                    setLimit(100);
                                }}
                            >
                                Reset Filters
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="job-status-content">
                {loading && (
                    <div className="loading-state">
                        <p>Loading jobs...</p>
                    </div>
                )}
                {error && (
                    <div className="error-state">
                        <p>Error: {error}</p>
                        <button onClick={loadJobs}>Retry</button>
                    </div>
                )}
                {!loading && !error && (
                    <div className="job-status-grid">
                        {statusCardConfigs.map((config) => (
                            <JobStatusCard
                                key={config.status}
                                config={config}
                                jobs={jobs}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

