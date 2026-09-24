-- Rollback: the shared fingerprint key policy may only be removed from an entirely empty Phase 1 domain.
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
      MESSAGE = 'refusing to remove the fingerprint key policy from a populated domain';
  END IF;
END;
$$;

DROP TRIGGER require_fingerprint_key_policy ON identity.identity_documents;
DROP FUNCTION identity.set_fingerprint_key_policy(varchar[]);
DROP FUNCTION identity.require_fingerprint_key_policy();
REVOKE SELECT (hmac_key_version) ON TABLE identity.document_fingerprint_claims
  FROM trayvi_lifecycle_owner;
DROP TABLE identity.fingerprint_key_policy;
