-- Rollback: restoring direct claim writes reopens arbitrary claim insertion and unverified state
-- changes, so it may only run against an entirely empty Phase 1 domain.
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
      MESSAGE = 'refusing to restore direct rotation claim writes on a populated domain';
  END IF;
END;
$$;

GRANT INSERT ON TABLE identity.document_fingerprint_claims TO trayvi_rotation;
GRANT UPDATE (state, bound_at, tombstoned_at)
  ON TABLE identity.document_fingerprint_claims TO trayvi_rotation;

DROP FUNCTION identity.backfill_fingerprint_alias(
  uuid, uuid, varchar, varchar, bytea, timestamptz
);

REVOKE UPDATE (tombstoned_at) ON TABLE identity.document_fingerprint_claims
  FROM trayvi_lifecycle_owner;
REVOKE INSERT ON TABLE identity.document_fingerprint_claims FROM trayvi_lifecycle_owner;
REVOKE SELECT (
  country_code,
  issuer_code,
  document_type,
  normalization_profile,
  hmac_algorithm,
  created_at
) ON TABLE identity.document_fingerprint_claims FROM trayvi_lifecycle_owner;
