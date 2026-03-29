-- Single source of truth for presses and ops: scheduler (Prisma). Copy legacy
-- public.machines / public.operations (if present), repoint machine_modes FK to
-- scheduler."Machine", then drop public tables.

-- 1) Presses → scheduler.Machine
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'machines') THEN
    INSERT INTO scheduler."Machine" (id, name, "displayName", enabled, "sortOrder", constants)
    WITH max_so AS (SELECT COALESCE(MAX("sortOrder"), -1) AS m FROM scheduler."Machine")
    SELECT
      p.machine_id::text,
      p.machine_id::text,
      COALESCE(NULLIF(btrim(p.machine_name::text), ''), p.machine_id::text),
      CASE WHEN p.availability_status = 'inactive' THEN false ELSE true END,
      ms.m + (row_number() OVER (ORDER BY p.machine_name NULLS LAST, p.machine_id::text))::int,
      '{}'::jsonb
    FROM public.machines p
    CROSS JOIN max_so ms
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 2) Operations → scheduler.Operation (id = lowercase legacy operation_id for scans)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'operations') THEN
    INSERT INTO scheduler."Operation" (id, "machineId", name, type, "sortOrder", enabled, notes, "calcFnKey")
    SELECT
      lower(o.operation_id::text),
      o.machine_id::text,
      COALESCE(o.operation_name, o.operation_id::text),
      COALESCE(NULLIF(trim(o.operation_category::text), ''), 'production'),
      (row_number() OVER (PARTITION BY o.machine_id ORDER BY o.operation_id))::int,
      true,
      o.description,
      NULL
    FROM public.operations o
    WHERE o.machine_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM scheduler."Machine" m WHERE m.id = o.machine_id::text)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 3) machine_modes.machine_id → scheduler."Machine" (was public.machines)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'machine_modes') THEN
    DELETE FROM machine_modes mm
    WHERE NOT EXISTS (SELECT 1 FROM scheduler."Machine" m WHERE m.id = mm.machine_id);

    ALTER TABLE machine_modes DROP CONSTRAINT IF EXISTS machine_modes_machine_id_fkey;

    ALTER TABLE machine_modes
      ADD CONSTRAINT machine_modes_machine_id_fkey
      FOREIGN KEY (machine_id) REFERENCES scheduler."Machine"(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4) Drop legacy public catalog (Ticket / scans use scheduler.Operation via Prisma)
DROP TABLE IF EXISTS public.operations;
DROP TABLE IF EXISTS public.machines;

COMMENT ON TABLE machine_modes IS 'Preset lists of scheduler.Operation.id (op001…) for Ticket / scans; optional.';
