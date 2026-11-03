-- Rollback: buckets may only be dropped while none exist (prune expired windows first).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.rate_limit_buckets LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth rate-limit buckets';
  END IF;
END;
$$;

DROP TABLE auth.rate_limit_buckets;
