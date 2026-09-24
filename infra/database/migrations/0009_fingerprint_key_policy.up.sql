-- Purpose: remediate P1-AUD-002. A shared, non-secret policy names the HMAC key versions every new
-- document must be fingerprinted under, so writers with disjoint key sets cannot both succeed; the
-- policy may only change to a set that every blocking document already covers.
-- Lock/rewrite risk: new table, functions, and a deferred trigger; no existing rows are rewritten.
-- Rollback: paired down migration refuses to remove the policy while any Phase 1 domain row exists.
CREATE TABLE identity.fingerprint_key_policy (
  id smallint PRIMARY KEY,
  required_versions varchar(64)[] NOT NULL,
  generation bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fingerprint_key_policy_singleton CHECK (id = 1),
  CONSTRAINT fingerprint_key_policy_versions_present CHECK (
    cardinality(required_versions) >= 1 AND array_position(required_versions, NULL) IS NULL
  ),
  CONSTRAINT fingerprint_key_policy_generation_positive CHECK (generation >= 1)
);

REVOKE ALL ON TABLE identity.fingerprint_key_policy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.fingerprint_key_policy TO trayvi_lifecycle_owner;
GRANT SELECT (hmac_key_version) ON TABLE identity.document_fingerprint_claims
  TO trayvi_lifecycle_owner;

CREATE FUNCTION identity.require_fingerprint_key_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  required varchar(64)[];
BEGIN
  -- FOR SHARE serializes this check against a concurrent policy change.
  SELECT policy.required_versions INTO required
  FROM identity.fingerprint_key_policy policy
  WHERE policy.id = 1
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fingerprint key policy is not configured', CONSTRAINT = 'fingerprint_key_policy_missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(required) AS required_version (version)
    WHERE NOT EXISTS (
      SELECT 1
      FROM identity.document_fingerprint_claims claim
      WHERE claim.document_id = NEW.id
        AND claim.hmac_key_version = required_version.version
        AND claim.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'document lacks a fingerprint for a required key version', CONSTRAINT = 'document_fingerprint_key_policy_unsatisfied';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION identity.set_fingerprint_key_policy(p_versions varchar[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  normalized varchar(64)[];
  next_generation bigint;
BEGIN
  IF p_versions IS NULL
    OR cardinality(p_versions) = 0
    OR array_position(p_versions, NULL) IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM unnest(p_versions) AS candidate (version)
      WHERE candidate.version !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'FINGERPRINT_KEY_POLICY_INVALID';
  END IF;
  SELECT array_agg(DISTINCT candidate.version ORDER BY candidate.version) INTO normalized
  FROM unnest(p_versions) AS candidate (version);
  IF cardinality(normalized) <> cardinality(p_versions) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'FINGERPRINT_KEY_POLICY_INVALID';
  END IF;

  -- Waits for in-flight writers holding FOR SHARE; later writers observe the new policy.
  PERFORM 1 FROM identity.fingerprint_key_policy policy WHERE policy.id = 1 FOR UPDATE;

  -- Every blocking document must already hold a fingerprint under at least one required version;
  -- otherwise a future writer could miss it entirely (for example, retiring a key before backfill).
  IF EXISTS (
    SELECT 1
    FROM identity.document_fingerprint_claims claim
    WHERE claim.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
      AND NOT EXISTS (
        SELECT 1
        FROM identity.document_fingerprint_claims covering
        WHERE covering.document_id = claim.document_id
          AND covering.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
          AND covering.hmac_key_version = ANY (normalized)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fingerprint key policy does not cover every blocking document', CONSTRAINT = 'fingerprint_key_policy_coverage';
  END IF;

  INSERT INTO identity.fingerprint_key_policy (id, required_versions, generation, updated_at)
  VALUES (1, normalized, 1, clock_timestamp())
  ON CONFLICT (id) DO UPDATE
    SET required_versions = EXCLUDED.required_versions,
        generation = identity.fingerprint_key_policy.generation + 1,
        updated_at = clock_timestamp()
  RETURNING generation INTO next_generation;
  RETURN next_generation;
END;
$$;

REVOKE ALL ON FUNCTION identity.require_fingerprint_key_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.set_fingerprint_key_policy(varchar[]) FROM PUBLIC;
ALTER FUNCTION identity.require_fingerprint_key_policy() OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION identity.set_fingerprint_key_policy(varchar[]) OWNER TO trayvi_lifecycle_owner;

CREATE CONSTRAINT TRIGGER require_fingerprint_key_policy
AFTER INSERT ON identity.identity_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION identity.require_fingerprint_key_policy();
