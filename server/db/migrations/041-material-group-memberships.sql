-- Many-to-many material ↔ substrate group (jobmanager `public.materials` + `public.material_groups`).
-- Backfills from legacy `materials.substrate_group`; keeps that column as the primary (first) group id.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'materials'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'material_groups'
  ) THEN
    CREATE TABLE IF NOT EXISTS public.material_group_memberships (
      material_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (material_id, group_id),
      CONSTRAINT material_group_memberships_material_fkey
        FOREIGN KEY (material_id) REFERENCES public.materials (material_id) ON DELETE CASCADE,
      CONSTRAINT material_group_memberships_group_fkey
        FOREIGN KEY (group_id) REFERENCES public.material_groups (group_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS material_group_memberships_group_id_idx
      ON public.material_group_memberships (group_id);

    INSERT INTO public.material_group_memberships (material_id, group_id, sort_order)
    SELECT m.material_id, m.substrate_group, 0
    FROM public.materials m
    WHERE m.substrate_group IS NOT NULL
      AND btrim(m.substrate_group::text) <> ''
    ON CONFLICT (material_id, group_id) DO NOTHING;
  END IF;
END $$;
