-- Run manually on the jobmanager / Print OS database (same DB as JOBMANAGER_DATABASE_URL).
-- Not applied by server/db/run-migrations.ts (that targets app/logs DB only).
--
-- Adds catalog provenance for NL vs NP material rows and backfills legacy rows as NL.

ALTER TABLE public.materials
  ADD COLUMN IF NOT EXISTS company text;

UPDATE public.materials
SET company = 'NL Material'
WHERE company IS NULL;

COMMENT ON COLUMN public.materials.company IS 'Catalog source: NL Material (legacy/default), NP Material (CSV import), etc.';
