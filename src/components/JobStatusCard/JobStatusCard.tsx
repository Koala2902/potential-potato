import { useState, useMemo } from 'react';
import { Job, JobStatusCardConfig, GroupedJobs } from '../../types';
import { ChevronDown, ChevronRight, Package, Printer, Scissors, Minus, CheckCircle2 } from 'lucide-react';
import './JobStatusCard.css';

// Icon mapping for dynamic icon rendering
const iconMap: Record<string, React.ComponentType<any>> = {
  Printer,
  Scissors,
  Minus,
  CheckCircle2,
  Package,
};

interface JobStatusCardProps {
  config: JobStatusCardConfig;
  jobs: Job[];
}

export default function JobStatusCard({ config, jobs }: JobStatusCardProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Filter jobs based on filter rule
  const filteredJobs = useMemo(() => {
    return jobs.filter(config.filterRule);
  }, [jobs, config.filterRule]);

  // Group and sort jobs
  const groupedJobs = useMemo(() => {
    const groups: Map<string, Job[]> = new Map();

    // Group jobs
    filteredJobs.forEach((job) => {
      let groupKey = '';
      
      switch (config.groupBy) {
        case 'material':
          groupKey = job.material || 'Unknown Material';
          break;
        case 'finishing':
          groupKey = job.finishing || 'Unknown Finishing';
          break;
        case 'material_finishing':
          groupKey = `${job.material || 'Unknown'}_${job.finishing || 'Unknown'}`;
          break;
        case 'runlist':
          groupKey = job.runlistId || 'No Runlist';
          break;
        default:
          groupKey = 'Ungrouped';
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(job);
    });

    // Sort jobs within each group
    const sortedGroups: GroupedJobs[] = Array.from(groups.entries()).map(([groupKey, groupJobs]) => {
      const sorted = [...groupJobs].sort((a, b) => {
        switch (config.sortBy) {
          case 'due_date':
            return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
          case 'created_at':
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          case 'job_code':
            return a.jobCode.localeCompare(b.jobCode);
          default:
            return 0;
        }
      });

      return { groupKey, jobs: sorted };
    });

    // Sort groups by most progressed status (for runlist grouping), then by due date
    const statusPriority: Record<string, number> = {
      'production_finished': 5,
      'slitter': 4,
      'digital_cut': 3,
      'printed': 2,
      'print_ready': 1,
    };
    
    return sortedGroups.sort((a, b) => {
      if (a.jobs.length === 0 || b.jobs.length === 0) return 0;
      
      // If grouping by runlist, sort by most progressed status first
      if (config.groupBy === 'runlist') {
        const getMaxStatus = (jobs: Job[]) => {
          return Math.max(...jobs.map(j => statusPriority[j.currentStatus || 'print_ready'] || 0));
        };
        
        const aMaxStatus = getMaxStatus(a.jobs);
        const bMaxStatus = getMaxStatus(b.jobs);
        
        if (aMaxStatus !== bMaxStatus) {
          return bMaxStatus - aMaxStatus; // Higher status first
        }
      }
      
      return new Date(a.jobs[0].dueDate).getTime() - new Date(b.jobs[0].dueDate).getTime();
    });
  }, [filteredJobs, config.groupBy, config.sortBy]);

  const toggleGroup = (groupKey: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(groupKey)) {
      newExpanded.delete(groupKey);
    } else {
      newExpanded.add(groupKey);
    }
    setExpandedGroups(newExpanded);
  };

  // Get icon component dynamically
  const IconComponent = iconMap[config.icon] || Package;

  const formatDateShort = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric'
    });
  };

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Check if this is the production_finished card
  const isProductionFinished = config.status === 'production_finished';

  const formatGroupKey = (key: string) => {
    if (config.groupBy === 'material_finishing') {
      const [material, finishing] = key.split('_');
      return `${material} / ${finishing}`;
    }
    if (config.groupBy === 'runlist') {
      // Extract only the number part before the first underscore
      const runlistNumber = key.split('_')[0];
      return runlistNumber;
    }
    return key;
  };

  return (
    <div className="job-status-card">
      <div className="job-status-card-header">
        <div className="card-title-section">
          <IconComponent size={20} className="card-icon" />
          <div>
            <h3 className="card-title">{config.title}</h3>
            <p className="card-description">{config.description}</p>
          </div>
        </div>
        <div className="card-count">{filteredJobs.length} jobs</div>
      </div>

      <div className="job-status-card-content">
        {groupedJobs.length === 0 ? (
          <div className="empty-groups">
            <Package size={32} />
            <p>No jobs in this status</p>
          </div>
        ) : (
          groupedJobs.map((group) => {
            const isExpanded = expandedGroups.has(group.groupKey);
            const totalQty = group.jobs.reduce((sum, job) => sum + job.versionQty, 0);
            const isRunlistGroup = config.groupBy === 'runlist';
            
            // Calculate progress for runlist grouping
            const statusPriority: Record<string, number> = {
              'production_finished': 5,
              'slitter': 4,
              'digital_cut': 3,
              'printed': 2,
              'print_ready': 1,
            };
            
            // Get most progressed status for the group
            const getMaxStatus = (jobs: Job[]) => {
              return Math.max(...jobs.map(j => statusPriority[j.currentStatus || 'print_ready'] || 0));
            };
            
            const maxStatus = getMaxStatus(group.jobs);
            const statusNames: Record<number, string> = {
              5: 'Production Finished',
              4: 'Slitter',
              3: 'Digital Cut',
              2: 'Printed',
              1: 'Print Ready',
            };
            
            // Count processed vs total jobs (processed = not print_ready)
            const processedJobs = group.jobs.filter(j => j.currentStatus !== 'print_ready').length;
            const totalJobs = group.jobs.length;
            const progressPercentage = totalJobs > 0 ? (processedJobs / totalJobs) * 100 : 0;

            return (
              <div key={group.groupKey} className="job-group">
                <div
                  className="group-header"
                  onClick={() => toggleGroup(group.groupKey)}
                >
                  <div className="group-toggle">
                    {isExpanded ? (
                      <ChevronDown size={18} />
                    ) : (
                      <ChevronRight size={18} />
                    )}
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
                </div>

                {isExpanded && (
                  <div className="group-jobs">
                    {group.jobs.map((job) => {
                      const totalVersions = job.totalVersions || 0;
                      const completedVersions = job.completedVersions || 0;
                      const percentage = totalVersions > 0 ? (completedVersions / totalVersions) * 100 : 0;
                      const isComplete = totalVersions > 0 && completedVersions === totalVersions;
                      const isProcessed = job.currentStatus !== 'print_ready';
                      const isGreyedOut = isRunlistGroup && !isProcessed;
                      
                      return (
                        <div key={job.id} className={`job-item ${isGreyedOut ? 'job-item-greyed' : ''}`}>
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

