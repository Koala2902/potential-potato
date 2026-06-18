-- Logs DB: imposition is embedded in code_text (imposition_id|||base); drop legacy column if present.
ALTER TABLE scanned_codes DROP COLUMN IF EXISTS imposition_id;

DROP INDEX IF EXISTS idx_scanned_codes_imposition_id;
