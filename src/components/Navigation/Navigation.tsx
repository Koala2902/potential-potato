import { Settings, Calendar, Factory, Activity } from 'lucide-react';
import './Navigation.css';

type Page = 'operation' | 'schedule' | 'production' | 'jobstatus';

interface NavigationProps {
    currentPage: Page;
    onPageChange: (page: Page) => void;
}

export default function Navigation({ currentPage, onPageChange }: NavigationProps) {
    const tabs = [
        { id: 'operation' as Page, label: 'Operation', icon: Settings },
        { id: 'schedule' as Page, label: 'Schedule', icon: Calendar },
        { id: 'production' as Page, label: 'Production', icon: Factory },
        { id: 'jobstatus' as Page, label: 'Job Status', icon: Activity },
    ];

    return (
        <nav className="navigation">
            {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = currentPage === tab.id;
                
                return (
                    <button
                        key={tab.id}
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

