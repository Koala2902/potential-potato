/**
 * Scheduler job `material` column: composite key `substrate_printcolour` (lowercase, underscores).
 * `fileName` holds the PDF / submission file name when different from the material key.
 */

export function slugifyMaterialPart(raw: string): string {
  const s = raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
  return s.slice(0, 128) || "unknown";
}

/** Stored value for `Job.material`: substrate + print colour (e.g. `white_pet_cmyk`). */
export function compositeMaterialPrintColour(substrate: string, printColour: string): string {
  return `${slugifyMaterialPart(substrate)}_${slugifyMaterialPart(printColour)}`;
}

/**
 * Split Labex-style Profile text (e.g. "White PET CMYK") into substrate vs print channel.
 */
export function splitLabexProfile(profile: string): { substrate: string; printColour: string } {
  const p = profile.trim();
  if (!p) return { substrate: "unknown", printColour: "cmyk" };
  const match = /\b(cmykw|cmyk|spot|uv)\b/i.exec(p);
  const printToken = match ? match[1].toLowerCase() : "cmyk";
  const substrate = p.replace(/\b(cmykw|cmyk|spot|uv)\b/gi, "").trim();
  return {
    substrate: substrate || "unknown",
    printColour: printToken,
  };
}
