-- Rollback: the auth schema may only be dropped while it is empty (no tables, functions, or other
-- objects remain from later Phase 2 migrations).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace = 'auth'::regnamespace
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = 'auth'::regnamespace
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_type
    WHERE typnamespace = 'auth'::regnamespace AND typrelid = 0
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop a non-empty auth schema';
  END IF;
END;
$$;

DROP SCHEMA auth;
