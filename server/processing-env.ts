/**
 * Automatic Print OS / scanned_codes processing on server startup and intervals.
 * On by default. Set DISABLE_SCAN_PROCESSING=true to turn off.
 */

function envFlag(name: string): boolean | null {
    const v = process.env[name]?.trim().toLowerCase();
    if (!v) return null;
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    return null;
}

export function isAutomaticScanProcessingEnabled(): boolean {
    const forcedOff = envFlag('DISABLE_SCAN_PROCESSING');
    if (forcedOff === true) return false;
    return true;
}
