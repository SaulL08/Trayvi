-- Rollback: callback receipts may only be dropped while none exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.provider_callback_receipts LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth provider callback receipts';
  END IF;
END;
$$;

DROP TABLE auth.provider_callback_receipts;
DROP FUNCTION auth.enforce_provider_callback_receipt();
