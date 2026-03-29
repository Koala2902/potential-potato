import { useState } from 'react';
import Navigation from './components/Navigation/Navigation';
import TicketPage from './pages/TicketPage/TicketPage';
import ProductionPage from './pages/ProductionPage/ProductionPage';
import { Scan } from 'lucide-react';
import SchedulerPage from './pages/SchedulerPage/SchedulerPage';
import ConfigPage from './pages/ConfigPage/ConfigPage';
import './App.css';

type Page = 'operation' | 'production' | 'schedule' | 'config';

function App() {
    const [currentPage, setCurrentPage] = useState<Page>('operation');

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

            <Navigation currentPage={currentPage} onPageChange={setCurrentPage} />

            <main className="app-content">
                {currentPage === 'operation' && <TicketPage />}
                {currentPage === 'production' && <ProductionPage />}
                {currentPage === 'schedule' && <SchedulerPage />}
                {currentPage === 'config' && <ConfigPage />}
            </main>
        </div>
    );
}

export default App;
