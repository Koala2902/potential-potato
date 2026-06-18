/** Pages shown in touch / iPad bottom navigation. */
export const TOUCH_NAV_PAGES = ['production', 'schedule', 'job', 'stock'] as const;

export type TouchNavPage = (typeof TOUCH_NAV_PAGES)[number];

export function isTouchNavPage(page: string): page is TouchNavPage {
    return (TOUCH_NAV_PAGES as readonly string[]).includes(page);
}
