-- Rollback: protected identity material may only be removed from an empty/fresh environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity.identity_documents LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.document_fingerprint_claims LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to remove populated Phase 1 protected identity data';
  END IF;
END;
$$;

REVOKE ALL ON TABLE identity.document_fingerprint_claims FROM trayvi_runtime;
REVOKE ALL ON TABLE identity.identity_documents FROM trayvi_runtime;
DROP TABLE identity.document_fingerprint_claims;
DROP TABLE identity.identity_documents;
