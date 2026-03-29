-- Align public.machines column types with legacy jobmanager (for migrate-jobmanager-tables).
-- Safe if 021 already created narrower/wrong types.

ALTER TABLE machines ALTER COLUMN machine_name DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines'
      AND column_name = 'capabilities' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE public.machines
      ALTER COLUMN capabilities TYPE text USING capabilities::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines'
      AND column_name = 'maintenance_schedule' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE public.machines
      ALTER COLUMN maintenance_schedule TYPE text USING maintenance_schedule::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines'
      AND column_name = 'max_web_width_mm' AND data_type = 'numeric'
  ) THEN
    ALTER TABLE public.machines
      ALTER COLUMN max_web_width_mm TYPE integer USING round(max_web_width_mm)::integer;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines'
      AND column_name = 'shift_hours' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE public.machines
      ALTER COLUMN shift_hours TYPE integer USING (
        CASE
          WHEN shift_hours IS NULL THEN NULL
          ELSE (shift_hours #>> '{}')::integer
        END
      );
  END IF;
END $$;

ALTER TABLE machines
  ALTER COLUMN availability_status SET DEFAULT 'available';

ALTER TABLE machines
  ALTER COLUMN shift_hours SET DEFAULT 8;
