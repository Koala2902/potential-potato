import { useEffect, useState } from 'react';

export type ViewportProfile = 'desktop' | 'touch';

const TOUCH_MQ = [
    '(pointer: coarse)',
    '(hover: none)',
    '(max-width: 1180px)',
] as const;

/** Dev/preview: `?viewport=touch` or `?viewport=desktop` overrides detection. */
export function getViewportOverride(): ViewportProfile | null {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('viewport')?.toLowerCase();
    if (v === 'touch' || v === 'desktop') return v;
    return null;
}

export function detectTouchPrimary(): boolean {
    if (typeof window === 'undefined') return false;
    const override = getViewportOverride();
    if (override === 'touch') return true;
    if (override === 'desktop') return false;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const noHover = window.matchMedia('(hover: none)').matches;
    const touchPoints = navigator.maxTouchPoints > 0;
    const narrow = window.matchMedia('(max-width: 1180px)').matches;
    return (coarse && noHover) || (touchPoints && noHover) || (touchPoints && narrow);
}

export function useViewportProfile(): ViewportProfile {
    const [profile, setProfile] = useState<ViewportProfile>(() => {
        const override = getViewportOverride();
        if (override) return override;
        return detectTouchPrimary() ? 'touch' : 'desktop';
    });

    useEffect(() => {
        const update = () => {
            setProfile(detectTouchPrimary() ? 'touch' : 'desktop');
        };

        update();

        const mqls = TOUCH_MQ.map((q) => window.matchMedia(q));
        for (const mql of mqls) {
            mql.addEventListener('change', update);
        }
        window.addEventListener('resize', update);

        return () => {
            for (const mql of mqls) {
                mql.removeEventListener('change', update);
            }
            window.removeEventListener('resize', update);
        };
    }, []);

    return profile;
}

/** Sync `data-viewport` on `<html>` for CSS-only touch layouts. */
export function useViewportDocumentAttribute(profile: ViewportProfile): void {
    useEffect(() => {
        document.documentElement.dataset.viewport = profile;
        return () => {
            delete document.documentElement.dataset.viewport;
        };
    }, [profile]);
}
