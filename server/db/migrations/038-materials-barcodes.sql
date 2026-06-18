-- Optional columns on jobmanager (or any DB hosting public.materials) for stock / scan lookup.
-- Safe to run on app DB when materials table is absent (guard block).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'materials'
  ) THEN
    ALTER TABLE public.materials
      ADD COLUMN IF NOT EXISTS internal_barcode TEXT,
      ADD COLUMN IF NOT EXISTS vendor_barcode TEXT,
      ADD COLUMN IF NOT EXISTS alternate_barcode TEXT;

    CREATE INDEX IF NOT EXISTS idx_materials_internal_barcode_lower
      ON public.materials (lower(trim(internal_barcode)))
      WHERE internal_barcode IS NOT NULL AND trim(internal_barcode) <> '';

    CREATE INDEX IF NOT EXISTS idx_materials_vendor_barcode_lower
      ON public.materials (lower(trim(vendor_barcode)))
      WHERE vendor_barcode IS NOT NULL AND trim(vendor_barcode) <> '';

    CREATE INDEX IF NOT EXISTS idx_materials_alternate_barcode_lower
      ON public.materials (lower(trim(alternate_barcode)))
      WHERE alternate_barcode IS NOT NULL AND trim(alternate_barcode) <> '';
  END IF;
END $$;
