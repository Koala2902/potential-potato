import { useState, useEffect } from 'react';
import FileList from './components/LeftPanel/FileList';
import PdfViewer from './components/MiddlePanel/PdfViewer';
import ProductionInfo from './components/RightPanel/ProductionInfo';
import { Job } from './types';
import { mockJobs } from './data/mockData';
import { Scan, Workflow } from 'lucide-react';
import './App.css';

function App() {
    const [jobs, setJobs] = useState<Job[]>(mockJobs);
    const [selectedJob, setSelectedJob] = useState<Job | null>(null);
    const [lastScannedJob, setLastScannedJob] = useState<Job | null>(null);

    // Simulate scanner functionality for demo purposes
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            // Listen for Enter key to simulate a barcode scan
            if (e.key === 'Enter' && selectedJob) {
                simulateScan(selectedJob);
            }
        };

        window.addEventListener('keypress', handleKeyPress);
        return () => window.removeEventListener('keypress', handleKeyPress);
    }, [selectedJob]);

    const simulateScan = (job: Job) => {
        const now = new Date().toISOString();

        setJobs((prevJobs) =>
            prevJobs.map((j) => {
                if (j.id !== job.id) return j;

                // Check if this is the first scan (start) or second scan (finish)
                if (j.status === 'pending') {
                    // First scan - mark as started
                    return {
                        ...j,
                        status: 'started',
                        startedAt: now,
                    };
                } else if (j.status === 'started') {
                    // Check if it's been more than 1 minute since start
                    const startTime = new Date(j.startedAt!).getTime();
                    const currentTime = new Date(now).getTime();
                    const diffMinutes = (currentTime - startTime) / (1000 * 60);

                    if (diffMinutes >= 1) {
                        // Second scan after 1 minute - mark as completed
                        return {
                            ...j,
                            status: 'completed',
                            completedAt: now,
                        };
                    } else {
                        // Scanned again within 1 minute - still in progress
                        return j;
                    }
                }

                return j;
            })
        );

        setLastScannedJob(job);
        setSelectedJob(job);

        // Clear last scanned highlight after 3 seconds
        setTimeout(() => {
            setLastScannedJob(null);
        }, 3000);
    };

    const handleSelectJob = (job: Job) => {
        setSelectedJob(job);
    };

    return (
        <div className="app">
            <header className="app-header">
                <div className="app-title">
                    <div className="app-logo">PS</div>
                    <h1>Production Suite</h1>
                </div>
                <div className="app-status">
                    <div className="connection-status">
                        <div className="status-indicator"></div>
                        <span className="status-text">Database Connected</span>
                    </div>
                    <div className="scanner-ready">
                        <Scan size={16} />
                        <span>Scanner Ready</span>
                    </div>
                </div>
            </header>

            <main className="app-content">
                <div className="left-panel">
                    <FileList
                        jobs={jobs}
                        selectedJob={selectedJob}
                        onSelectJob={handleSelectJob}
                        lastScannedJob={lastScannedJob}
                    />
                </div>

                <div className="middle-panel">
                    <PdfViewer job={selectedJob} />
                </div>

                <div className="right-panel">
                    <ProductionInfo job={selectedJob} />
                </div>
            </main>
        </div>
    );
}

export default App;
