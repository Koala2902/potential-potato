-- Scheduler Job: store PDF name in fileName; material holds substrate_printcolour composite.
ALTER TABLE scheduler."Job" ADD COLUMN IF NOT EXISTS "fileName" TEXT;

-- Backdate switch/Labex rows: copy former file name out of material before TS backfill sets composite material.
UPDATE scheduler."Job"
SET "fileName" = "material"
WHERE "source" = 'switch'
  AND "fileName" IS NULL;
