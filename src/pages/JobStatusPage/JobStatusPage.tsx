import { useState } from 'react';
import { Activity, Printer, Scissors, Cut, CheckCircle2 } from 'lucide-react';
import { Job, JobStatusCardConfig } from '../../types';
import JobStatusCard from '../../components/JobStatusCard/JobStatusCard';
import './JobStatusPage.css';

// Mock data - will be replaced with API calls later
const mockJobs: Job[] = [
    {
        id: '1',
        jobCode: 'JOB-2025-001',
        rollId: 'ROLL-001',
        orderId: 'ORD-12345',
        ticketId: 'TKT-67890',
        versionTag: 'v2.1',
        versionQty: 500,
        pdfPath: '/pdfs/job-001.pdf',
        status: 'pending',
        dueDate: '2025-12-15T10:00:00Z',
        comments: 'Premium glossy finish required',
        qtyExplanation: 'Original order: 500 units',
        positionInRoll: 1,
        createdAt: '2025-12-10T08:00:00Z',
        material: 'Glossy Paper',
        finishing: 'Lamination',
        operations: {},
    },
    {
        id: '2',
        jobCode: 'JOB-2025-002',
        rollId: 'ROLL-001',
        orderId: 'ORD-12346',
        ticketId: 'TKT-67891',
        versionTag: 'v1.0',
        versionQty: 1000,
        pdfPath: '/pdfs/job-002.pdf',
        status: 'started',
        dueDate: '2025-12-16T14:00:00Z',
        comments: 'Standard matte finish',
        qtyExplanation: 'Printing 1050 units total',
        positionInRoll: 2,
        createdAt: '2025-12-10T08:05:00Z',
        startedAt: '2025-12-12T10:30:00Z',
        material: 'Matte Paper',
        finishing: 'UV Coating',
        operations: { print: true },
    },
    {
        id: '3',
        jobCode: 'JOB-2025-003',
        rollId: 'ROLL-002',
        orderId: 'ORD-12347',
        ticketId: 'TKT-67892',
        versionTag: 'v1.5',
        versionQty: 750,
        pdfPath: '/pdfs/job-003.pdf',
        status: 'started',
        dueDate: '2025-12-17T09:00:00Z',
        comments: 'Premium finish',
        qtyExplanation: '750 units',
        positionInRoll: 1,
        createdAt: '2025-12-11T08:00:00Z',
        startedAt: '2025-12-13T09:00:00Z',
        material: 'Glossy Paper',
        finishing: 'Lamination',
        operations: { print: true, coating: true },
    },
    {
        id: '4',
        jobCode: 'JOB-2025-004',
        rollId: 'ROLL-002',
        orderId: 'ORD-12348',
        ticketId: 'TKT-67893',
        versionTag: 'v2.0',
        versionQty: 600,
        pdfPath: '/pdfs/job-004.pdf',
        status: 'started',
        dueDate: '2025-12-18T11:00:00Z',
        comments: 'Standard finish',
        qtyExplanation: '600 units',
        positionInRoll: 2,
        createdAt: '2025-12-11T08:10:00Z',
        startedAt: '2025-12-13T10:00:00Z',
        material: 'Matte Paper',
        finishing: 'UV Coating',
        operations: { print: true, coating: true, kiss_cut: true, backscore: true },
    },
    {
        id: '5',
        jobCode: 'JOB-2025-005',
        rollId: 'ROLL-003',
        orderId: 'ORD-12349',
        ticketId: 'TKT-67894',
        versionTag: 'v1.0',
        versionQty: 1200,
        pdfPath: '/pdfs/job-005.pdf',
        status: 'completed',
        dueDate: '2025-12-14T15:00:00Z',
        comments: 'All operations complete',
        qtyExplanation: '1200 units',
        positionInRoll: 1,
        createdAt: '2025-12-09T08:00:00Z',
        startedAt: '2025-12-10T09:00:00Z',
        completedAt: '2025-12-12T16:00:00Z',
        material: 'Glossy Paper',
        finishing: 'Lamination',
        operations: { print: true, coating: true, kiss_cut: true, backscore: true, slitter: true },
    },
];

export default function JobStatusPage() {
    const [jobs] = useState<Job[]>(mockJobs);

    // Define status card configurations
    const statusCardConfigs: JobStatusCardConfig[] = [
        {
            status: 'print_ready',
            title: 'Print Ready',
            description: 'All jobs without any status yet',
            icon: 'Printer',
            filterRule: (job: Job) => {
                // No operations completed
                return !job.operations || Object.keys(job.operations).length === 0 || 
                       Object.values(job.operations).every(op => !op);
            },
            groupBy: 'material',
            sortBy: 'due_date',
        },
        {
            status: 'printed',
            title: 'Printed',
            description: 'Print operation completed',
            icon: 'Printer',
            filterRule: (job: Job) => {
                return job.operations?.print === true && 
                       (!job.operations?.coating || job.operations.coating === false);
            },
            groupBy: 'material_finishing',
            sortBy: 'due_date',
        },
        {
            status: 'digital_cut',
            title: 'Digital Cut',
            description: 'Coating operation completed',
            icon: 'Scissors',
            filterRule: (job: Job) => {
                return job.operations?.coating === true && 
                       (!job.operations?.kiss_cut || job.operations.kiss_cut === false);
            },
            groupBy: 'material_finishing',
            sortBy: 'due_date',
        },
        {
            status: 'slitter',
            title: 'Slitter',
            description: 'Kiss cut and backscore done, slitter pending',
            icon: 'Cut',
            filterRule: (job: Job) => {
                return job.operations?.kiss_cut === true && 
                       job.operations?.backscore === true &&
                       (!job.operations?.slitter || job.operations.slitter === false);
            },
            groupBy: 'material_finishing',
            sortBy: 'due_date',
        },
        {
            status: 'production_finished',
            title: 'Production Finished',
            description: 'All operations completed',
            icon: 'CheckCircle2',
            filterRule: (job: Job) => {
                return job.operations?.print === true &&
                       job.operations?.coating === true &&
                       job.operations?.kiss_cut === true &&
                       job.operations?.backscore === true &&
                       job.operations?.slitter === true;
            },
            groupBy: 'material_finishing',
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
            </div>

            <div className="job-status-content">
                <div className="job-status-grid">
                    {statusCardConfigs.map((config) => (
                        <JobStatusCard
                            key={config.status}
                            config={config}
                            jobs={jobs}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

