-- Append-only log for POST /api/stock/materials/:id/adjust (receive / take out).
-- Safe when public.materials is absent (guard block).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'materials'
  ) THEN
    CREATE TABLE IF NOT EXISTS public.material_stock_movements (
      movement_id bigserial PRIMARY KEY,
      material_id text NOT NULL REFERENCES public.materials (material_id),
      requested_delta numeric NOT NULL,
      applied_delta numeric NOT NULL,
      stock_before numeric NOT NULL,
      stock_after numeric NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_material_stock_movements_material_created
      ON public.material_stock_movements (material_id, created_at DESC);
  END IF;
END $$;
