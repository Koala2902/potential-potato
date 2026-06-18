import { useEffect, useState } from 'react';
import { Scan } from 'lucide-react';
import { useViewportDocumentAttribute, useViewportProfile } from './hooks/useViewportProfile';
import { isTouchNavPage } from './lib/touch-nav';
import Navigation, { type AppPage } from './components/Navigation/Navigation';
import TicketPage from './pages/TicketPage/TicketPage';
import ProductionPage from './pages/ProductionPage/ProductionPage';
import SchedulerPage from './pages/SchedulerPage/SchedulerPage';
import ConfigPage from './pages/ConfigPage/ConfigPage';
import JobPage from './pages/JobPage/JobPage';
import AnalyticsPage from './pages/AnalyticsPage/AnalyticsPage';
import StockPage from './pages/StockPage/StockPage';
import './App.css';

function App() {
    const viewportProfile = useViewportProfile();
    useViewportDocumentAttribute(viewportProfile);
    const isTouch = viewportProfile === 'touch';

    const [currentPage, setCurrentPage] = useState<AppPage>(() =>
        isTouch ? 'production' : 'operation'
    );
    const [stockFocusMaterialId, setStockFocusMaterialId] = useState<string | null>(null);
    const [stockFocusOpenMovement, setStockFocusOpenMovement] = useState<'issue' | null>(null);

    useEffect(() => {
        if (isTouch && !isTouchNavPage(currentPage)) {
            setCurrentPage('production');
        }
    }, [isTouch, currentPage]);

    const onPageChange = (page: AppPage) => {
        if (isTouch && !isTouchNavPage(page)) return;
        setCurrentPage(page);
    };

    return (
        <div className="app" data-viewport={viewportProfile}>
            {!isTouch ? (
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
            ) : null}

            <Navigation currentPage={currentPage} onPageChange={onPageChange} touchOnly={isTouch} />

            <main className="app-content">
                {!isTouch && currentPage === 'operation' && (
                    <TicketPage
                        onMaterialStockScan={(id) => {
                            setStockFocusMaterialId(id);
                            setStockFocusOpenMovement('issue');
                            setCurrentPage('stock');
                        }}
                    />
                )}
                {currentPage === 'production' && <ProductionPage />}
                {currentPage === 'schedule' && <SchedulerPage />}
                {currentPage === 'job' && <JobPage />}
                {!isTouch && currentPage === 'analytics' && <AnalyticsPage />}
                {currentPage === 'stock' && (
                    <StockPage
                        focusMaterialId={stockFocusMaterialId}
                        focusOpenStockMovement={stockFocusOpenMovement}
                        onFocusConsumed={() => {
                            setStockFocusMaterialId(null);
                            setStockFocusOpenMovement(null);
                        }}
                    />
                )}
                {!isTouch && currentPage === 'config' && <ConfigPage />}
            </main>
        </div>
    );
}

export default App;
