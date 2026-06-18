/**
 * When an imposition is known, store only that id in scanned_codes.code_text.
 * Legacy rows may still use `impositionId|||baseScan` — see decodeScanCodeText.
 */
export const LEGACY_SCAN_CODE_IMPOSITION_SEPARATOR = "|||";

/** If imposition id is set, persist that alone; otherwise the raw scan string. */
export function encodeScanCodeTextWithImposition(
    impositionId: string | null | undefined,
    baseCodeText: string
): string {
    const imp = impositionId?.trim();
    if (imp) return imp;
    return baseCodeText.trim();
}

/** Split legacy `imp|||base` rows; new rows are either imposition-only or plain scan. */
export function decodeScanCodeText(stored: string): {
    baseCodeText: string;
    legacyImpositionPrefix: string | null;
} {
    const s = stored ?? "";
    const sep = LEGACY_SCAN_CODE_IMPOSITION_SEPARATOR;
    const idx = s.indexOf(sep);
    if (idx <= 0) {
        return { baseCodeText: s, legacyImpositionPrefix: null };
    }
    const prefix = s.slice(0, idx).trim();
    const base = s.slice(idx + sep.length);
    return {
        baseCodeText: base.length > 0 ? base : s,
        legacyImpositionPrefix: prefix.length > 0 ? prefix : null,
    };
}
