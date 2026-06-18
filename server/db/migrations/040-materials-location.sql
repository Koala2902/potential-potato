-- Optional warehouse / bin label on jobmanager `public.materials`.
-- Safe when table is absent (guard block).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'materials'
  ) THEN
    ALTER TABLE public.materials
      ADD COLUMN IF NOT EXISTS location TEXT;
  END IF;
END $$;
