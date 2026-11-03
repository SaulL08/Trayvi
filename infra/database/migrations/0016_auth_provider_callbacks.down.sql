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

DROP FUNCTION auth.record_challenge_delivery_status(uuid, varchar, timestamptz);
REVOKE UPDATE (delivery_outcome_code, updated_at) ON TABLE auth.verification_challenges
  FROM trayvi_lifecycle_owner;
REVOKE SELECT (id, delivery_outcome_code) ON TABLE auth.verification_challenges
  FROM trayvi_lifecycle_owner;
DROP TABLE auth.provider_callback_receipts;
DROP FUNCTION auth.enforce_provider_callback_receipt();
