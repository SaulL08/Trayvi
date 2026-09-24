-- Purpose: remediate P1-AUD-005. HMAC backfill and KEK rewrap run as the dedicated trayvi_rotation
-- workload with only the columns and commands they need, instead of the migration/owner principal.
-- Lock/rewrite risk: privilege changes only.
-- Rollback: paired down migration refuses to revoke the rotation grants from a populated domain.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_rotation') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = 'run infra/database/bootstrap/0001_roles.sql before migration 0010';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA identity, platform TO trayvi_rotation;

-- Decrypt-for-backfill and rewrap read the envelope; only the wrapped DEK and its KEK version change.
GRANT SELECT (
  id,
  identity_id,
  country_code,
  issuer_code,
  document_type,
  normalization_profile,
  encryption_algorithm,
  encryption_schema_version,
  kek_key_version,
  ciphertext,
  nonce,
  authentication_tag,
  wrapped_dek,
  state
) ON TABLE identity.identity_documents TO trayvi_rotation;
GRANT UPDATE (kek_key_version, wrapped_dek, updated_at)
  ON TABLE identity.identity_documents TO trayvi_rotation;

-- Backfill inserts new-version aliases, mirrors the source claim state, and verifies them.
GRANT SELECT (id, document_id, hmac_key_version, fingerprint, state, created_at)
  ON TABLE identity.document_fingerprint_claims TO trayvi_rotation;
GRANT INSERT ON TABLE identity.document_fingerprint_claims TO trayvi_rotation;
GRANT UPDATE (state, bound_at, tombstoned_at)
  ON TABLE identity.document_fingerprint_claims TO trayvi_rotation;

-- Idempotent event inserts use ON CONFLICT (id), which requires reading the conflict column.
GRANT INSERT ON TABLE platform.outbox_events TO trayvi_rotation;
GRANT SELECT (id) ON TABLE platform.outbox_events TO trayvi_rotation;

GRANT EXECUTE ON FUNCTION identity.set_fingerprint_key_policy(varchar[]) TO trayvi_rotation;
