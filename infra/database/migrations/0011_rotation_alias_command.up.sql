-- Purpose: narrow the trayvi_rotation workload (issue #6). Fingerprint alias backfill moves behind a
-- SECURITY DEFINER command that derives scope and lifecycle state from an existing claim of the same
-- document. Rotation can no longer insert arbitrary claims (blocking other people's fingerprints)
-- or move an in-flight RESERVED claim to BOUND/TOMBSTONED outside trusted verification.
-- Lock/rewrite risk: privilege changes and a new function only; no rows are rewritten.
-- Rollback: paired down migration restores the 0010 direct claim grants and drops the command.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_rotation')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_lifecycle_owner')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = 'run infra/database/bootstrap/0001_roles.sql before migration 0011';
  END IF;
END;
$$;

-- The command owner needs to read a source claim's scope and insert/settle the mirrored alias.
GRANT SELECT (
  country_code,
  issuer_code,
  document_type,
  normalization_profile,
  hmac_algorithm,
  created_at
) ON TABLE identity.document_fingerprint_claims TO trayvi_lifecycle_owner;
GRANT INSERT ON TABLE identity.document_fingerprint_claims TO trayvi_lifecycle_owner;
GRANT UPDATE (tombstoned_at) ON TABLE identity.document_fingerprint_claims
  TO trayvi_lifecycle_owner;

CREATE FUNCTION identity.backfill_fingerprint_alias(
  p_claim_id uuid,
  p_document_id uuid,
  p_hmac_algorithm varchar,
  p_hmac_key_version varchar,
  p_fingerprint bytea,
  p_occurred_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source record;
  inserted_id uuid;
BEGIN
  IF p_claim_id IS NULL OR p_document_id IS NULL OR p_hmac_key_version IS NULL
    OR p_fingerprint IS NULL OR p_occurred_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ROTATION_ALIAS_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM identity.identity_documents document
    WHERE document.id = p_document_id AND document.state <> 'CRYPTOSHREDDED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROTATION_DOCUMENT_UNAVAILABLE';
  END IF;

  -- Replays and versions the document already holds are a no-op; the caller verifies the result.
  IF EXISTS (
    SELECT 1 FROM identity.document_fingerprint_claims claim
    WHERE claim.document_id = p_document_id AND claim.hmac_key_version = p_hmac_key_version
  ) THEN
    RETURN 'EXISTS';
  END IF;

  -- The alias mirrors the oldest blocking claim held under a different key version. Locking it
  -- keeps its state stable until the alias commits; ABANDONED claims are never a source.
  SELECT claim.country_code, claim.issuer_code, claim.document_type,
         claim.normalization_profile, claim.state
  INTO source
  FROM identity.document_fingerprint_claims claim
  WHERE claim.document_id = p_document_id
    AND claim.hmac_key_version <> p_hmac_key_version
    AND claim.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
  ORDER BY claim.created_at, claim.id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ROTATION_SOURCE_CLAIM_MISSING';
  END IF;

  INSERT INTO identity.document_fingerprint_claims (
    id, document_id, country_code, issuer_code, document_type,
    normalization_profile, hmac_algorithm, hmac_key_version,
    fingerprint, state, created_at
  ) VALUES (
    p_claim_id, p_document_id, source.country_code, source.issuer_code, source.document_type,
    source.normalization_profile, p_hmac_algorithm, p_hmac_key_version,
    p_fingerprint, 'RESERVED', p_occurred_at
  )
  ON CONFLICT (document_id, hmac_key_version) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    RETURN 'EXISTS';
  END IF;

  IF source.state = 'BOUND' THEN
    UPDATE identity.document_fingerprint_claims
    SET state = 'BOUND', bound_at = p_occurred_at
    WHERE id = inserted_id;
  ELSIF source.state = 'TOMBSTONED' THEN
    UPDATE identity.document_fingerprint_claims
    SET state = 'TOMBSTONED', tombstoned_at = p_occurred_at
    WHERE id = inserted_id;
  END IF;
  RETURN 'INSERTED';
END;
$$;

REVOKE ALL ON FUNCTION identity.backfill_fingerprint_alias(
  uuid, uuid, varchar, varchar, bytea, timestamptz
) FROM PUBLIC;
ALTER FUNCTION identity.backfill_fingerprint_alias(
  uuid, uuid, varchar, varchar, bytea, timestamptz
) OWNER TO trayvi_lifecycle_owner;
GRANT EXECUTE ON FUNCTION identity.backfill_fingerprint_alias(
  uuid, uuid, varchar, varchar, bytea, timestamptz
) TO trayvi_rotation;

-- Rotation keeps read access for verification but loses every direct claim write.
REVOKE INSERT ON TABLE identity.document_fingerprint_claims FROM trayvi_rotation;
REVOKE UPDATE (state, bound_at, tombstoned_at)
  ON TABLE identity.document_fingerprint_claims FROM trayvi_rotation;
