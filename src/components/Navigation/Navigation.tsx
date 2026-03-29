import { Settings, Factory, CalendarDays, Cog } from 'lucide-react';
import './Navigation.css';

type Page = 'operation' | 'production' | 'schedule' | 'config';

interface NavigationProps {
    currentPage: Page;
    onPageChange: (page: Page) => void;
}

export default function Navigation({ currentPage, onPageChange }: NavigationProps) {
    const tabs = [
        { id: 'operation' as Page, label: 'Operation', icon: Settings },
        { id: 'production' as Page, label: 'Production', icon: Factory },
        { id: 'schedule' as Page, label: 'Schedule', icon: CalendarDays },
        { id: 'config' as Page, label: 'Config', icon: Cog },
    ];

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

