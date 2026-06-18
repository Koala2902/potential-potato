/**
 * Verifies tablet legacy can reach the API (direct :3001 and via :5175 proxy).
 * Run: npm run check:tablet-api
 */
const API = 'http://127.0.0.1:3001';
const PROXY = 'http://127.0.0.1:5175';

async function check(label: string, url: string): Promise<boolean> {
    try {
        const res = await fetch(url);
        const text = await res.text();
        if (!res.ok) {
            console.error(`  FAIL ${label}: HTTP ${res.status} ${text.slice(0, 120)}`);
            return false;
        }
        const data = JSON.parse(text) as unknown;
        const n = Array.isArray(data) ? data.length : '?';
        console.log(`  OK   ${label}: HTTP ${res.status} (${n} items)`);
        return true;
    } catch (e) {
        console.error(`  FAIL ${label}:`, e instanceof Error ? e.message : e);
        return false;
    }
}

async function main() {
    console.log('Tablet API checks\n');
    let ok = true;
    ok = (await check('API :3001 /api/machines', `${API}/api/machines`)) && ok;
    ok =
        (await check(
            'API :3001 /api/production-status',
            `${API}/api/production-status`
        )) && ok;
    ok =
        (await check(
            'Vite :5175 proxy /api/machines',
            `${PROXY}/api/machines`
        )) && ok;
    ok =
        (await check(
            'Vite :5175 proxy /api/production-status',
            `${PROXY}/api/production-status`
        )) && ok;
    ok =
        (await check(
            'Stock materials (NL)',
            `${PROXY}/api/stock/materials?activeOnly=true&company=${encodeURIComponent('NL Material')}`
        )) && ok;

    if (!ok) {
        console.error(
            '\nFix: npm run dev (API :3001) and npm run dev:tablet (UI :5175). Tablet bookmark must use port 5175.'
        );
        process.exit(1);
    }
    console.log('\nAll checks passed. Tablet URL: http://<your-lan-ip>:5175/#/production');
}

main();
