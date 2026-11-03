-- Rollback: the rotation workload grants may only be revoked from an entirely empty Phase 1 domain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts.account_creation_operations LIMIT 1)
    OR EXISTS (SELECT 1 FROM accounts.accounts LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.person_identities LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.identity_documents LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.document_fingerprint_claims LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to revoke rotation workload grants from a populated domain';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION identity.set_fingerprint_key_policy(varchar[]) FROM trayvi_rotation;
REVOKE ALL ON TABLE platform.outbox_events FROM trayvi_rotation;
REVOKE ALL ON TABLE identity.document_fingerprint_claims FROM trayvi_rotation;
REVOKE ALL ON TABLE identity.identity_documents FROM trayvi_rotation;
REVOKE USAGE ON SCHEMA identity, platform FROM trayvi_rotation;
