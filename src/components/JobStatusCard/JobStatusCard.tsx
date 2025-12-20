import { useState, useMemo } from 'react';
import { Job, JobStatusCardConfig, GroupedJobs } from '../../types';
import { ChevronDown, ChevronRight, Calendar, Package, Printer, Scissors, Cut, CheckCircle2 } from 'lucide-react';
import './JobStatusCard.css';

// Icon mapping for dynamic icon rendering
const iconMap: Record<string, React.ComponentType<any>> = {
  Printer,
  Scissors,
  Cut,
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

    // Sort groups by first job's due date (or other criteria)
    return sortedGroups.sort((a, b) => {
      if (a.jobs.length === 0 || b.jobs.length === 0) return 0;
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

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatGroupKey = (key: string) => {
    if (config.groupBy === 'material_finishing') {
      const [material, finishing] = key.split('_');
      return `${material} / ${finishing}`;
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
                  <div className="group-info">
                    <div className="group-name">{formatGroupKey(group.groupKey)}</div>
                    <div className="group-meta">
                      {group.jobs.length} {group.jobs.length === 1 ? 'job' : 'jobs'} • {totalQty.toLocaleString()} units
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="group-jobs">
                    {group.jobs.map((job) => (
                      <div key={job.id} className="job-item">
                        <div className="job-main-info">
                          <div className="job-code">{job.jobCode}</div>
                          <div className="job-order">Order: {job.orderId}</div>
                        </div>
                        <div className="job-details">
                          <div className="job-detail-item">
                            <Calendar size={14} />
                            <span>Due: {formatDate(job.dueDate)}</span>
                          </div>
                          <div className="job-detail-item">
                            <Package size={14} />
                            <span>Qty: {job.versionQty.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    ))}
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

