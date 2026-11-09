-- Rollback: password tables may only be dropped while no credential or transition exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.password_credentials LIMIT 1)
    OR EXISTS (SELECT 1 FROM auth.password_credential_transitions LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to drop populated auth password tables';
  END IF;
END;
$$;

DROP TABLE auth.password_credential_transitions;
DROP TABLE auth.password_credentials;
DROP FUNCTION auth.reject_password_transition_mutation();
DROP FUNCTION auth.enforce_password_credential_lifecycle();
