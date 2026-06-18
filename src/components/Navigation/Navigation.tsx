import { Settings, Factory, CalendarDays, Cog, KanbanSquare, BarChart3, Package } from 'lucide-react';
import { TOUCH_NAV_PAGES, type TouchNavPage } from '../../lib/touch-nav';
import './Navigation.css';

export type AppPage = TouchNavPage | 'operation' | 'analytics' | 'config';

interface NavigationProps {
    currentPage: AppPage;
    onPageChange: (page: AppPage) => void;
    touchOnly?: boolean;
}

const TABS: { id: AppPage; label: string; icon: typeof Factory }[] = [
    { id: 'operation', label: 'Operation', icon: Settings },
    { id: 'production', label: 'Production', icon: Factory },
    { id: 'schedule', label: 'Schedule', icon: CalendarDays },
    { id: 'job', label: 'Job', icon: KanbanSquare },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'stock', label: 'Stock', icon: Package },
    { id: 'config', label: 'Config', icon: Cog },
];

export default function Navigation({ currentPage, onPageChange, touchOnly = false }: NavigationProps) {
    const touchSet = new Set<string>(TOUCH_NAV_PAGES);
    const tabs = touchOnly ? TABS.filter((t) => touchSet.has(t.id)) : TABS;

    return (
        <nav className="navigation">
            {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = currentPage === tab.id;

                return (
                    <button
                        key={tab.id}
                        type="button"
                        data-testid={
                            tab.id === 'schedule'
                                ? 'nav-schedule'
                                : tab.id === 'config'
                                  ? 'nav-config'
                                  : tab.id === 'analytics'
                                    ? 'nav-analytics'
                                    : tab.id === 'stock'
                                      ? 'nav-stock'
                                      : undefined
                        }
                        className={`nav-tab ${isActive ? 'active' : ''}`}
                        onClick={() => onPageChange(tab.id)}
                    >
                        <Icon size={18} />
                        <span>{tab.label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
