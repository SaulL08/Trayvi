-- Purpose: add provider-neutral verification/review foundations and enforce Phase 1 lifecycles in PostgreSQL.
-- Lock/rewrite risk: new tables and triggers only; existing Phase 1 tables are expected to be empty at first apply.
-- Rollback: paired down migration refuses to remove guards while any Phase 1 domain row exists.
CREATE TABLE identity.verification_cases (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES identity.person_identities (id) ON DELETE RESTRICT,
  previous_case_id uuid REFERENCES identity.verification_cases (id) ON DELETE RESTRICT,
  decision_id uuid UNIQUE,
  method_class varchar(64) NOT NULL,
  status varchar(24) NOT NULL,
  result_code varchar(100),
  policy_version varchar(64) NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT verification_case_method_format CHECK (
    method_class ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT verification_case_status_valid CHECK (
    status IN ('PENDING', 'VERIFIED', 'FAILED', 'INCONCLUSIVE', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT verification_case_result_format CHECK (
    result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
  ),
  CONSTRAINT verification_case_policy_format CHECK (
    policy_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT verification_case_result_shape CHECK (
    (
      status = 'PENDING'
      AND decision_id IS NULL
      AND result_code IS NULL
      AND resolved_at IS NULL
    )
    OR (
      status <> 'PENDING'
      AND decision_id IS NOT NULL
      AND result_code IS NOT NULL
      AND resolved_at IS NOT NULL
    )
  ),
  CONSTRAINT verification_case_timestamp_order CHECK (
    expires_at > opened_at AND (resolved_at IS NULL OR resolved_at >= opened_at)
  )
);

CREATE INDEX verification_cases_identity_idx
  ON identity.verification_cases (identity_id, opened_at DESC, id);

CREATE TABLE identity.verification_evidence (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES identity.verification_cases (id) ON DELETE RESTRICT,
  evidence_type varchar(64) NOT NULL,
  provider_alias varchar(64) NOT NULL,
  collected_at timestamptz NOT NULL,
  digest_algorithm varchar(32) NOT NULL,
  evidence_digest bytea NOT NULL,
  restricted_reference varchar(512) NOT NULL,
  retention_class varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT verification_evidence_type_format CHECK (
    evidence_type ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND provider_alias ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT verification_evidence_digest_valid CHECK (
    digest_algorithm = 'sha-256' AND octet_length(evidence_digest) = 32
  ),
  CONSTRAINT verification_evidence_reference_length CHECK (
    length(btrim(restricted_reference)) BETWEEN 1 AND 512
  ),
  CONSTRAINT verification_evidence_retention_format CHECK (
    retention_class ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT verification_evidence_timestamp_order CHECK (created_at >= collected_at)
);

CREATE TABLE identity.identity_reviews (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES identity.verification_cases (id) ON DELETE RESTRICT,
  state varchar(24) NOT NULL,
  actor_class varchar(64) NOT NULL,
  actor_reference varchar(128) NOT NULL,
  reason_code varchar(100) NOT NULL,
  evidence_reference uuid NOT NULL REFERENCES identity.verification_evidence (id) ON DELETE RESTRICT,
  policy_version varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT identity_review_state_valid CHECK (
    state IN ('NOT_REQUIRED', 'QUEUED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED')
  ),
  CONSTRAINT identity_review_actor_format CHECK (
    actor_class ~ '^[A-Z][A-Z0-9_]{0,63}$' AND length(btrim(actor_reference)) > 0
  ),
  CONSTRAINT identity_review_reason_format CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  CONSTRAINT identity_review_policy_format CHECK (
    policy_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT identity_review_resolution_shape CHECK (
    (state IN ('QUEUED', 'IN_REVIEW') AND resolved_at IS NULL)
    OR (state IN ('NOT_REQUIRED', 'APPROVED', 'REJECTED', 'CANCELLED') AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT identity_review_timestamp_order CHECK (
    updated_at >= created_at AND (resolved_at IS NULL OR resolved_at >= created_at)
  )
);

CREATE FUNCTION accounts.enforce_account_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_IDENTITY' OR NEW.version <> 0 OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial account state', CONSTRAINT = 'account_lifecycle_transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable account fields changed', CONSTRAINT = 'account_immutable_fields';
  END IF;
  IF OLD.status = NEW.status OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid account state update', CONSTRAINT = 'account_lifecycle_transition';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING_IDENTITY' AND NEW.status IN ('ACTIVE', 'CLOSED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('RESTRICTED', 'SUSPENDED', 'CLOSED'))
    OR (OLD.status = 'RESTRICTED' AND NEW.status IN ('ACTIVE', 'SUSPENDED', 'CLOSED'))
    OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'RESTRICTED', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account lifecycle transition denied', CONSTRAINT = 'account_lifecycle_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION identity.enforce_identity_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.version <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial identity state', CONSTRAINT = 'identity_lifecycle_transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.account_id IS DISTINCT FROM NEW.account_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable identity fields changed', CONSTRAINT = 'identity_immutable_fields';
  END IF;
  IF OLD.status = NEW.status OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid identity state update', CONSTRAINT = 'identity_lifecycle_transition';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('ESTABLISHED', 'RETIRED'))
    OR (OLD.status = 'ESTABLISHED' AND NEW.status IN ('RESTRICTED', 'RETIRED'))
    OR (OLD.status = 'RESTRICTED' AND NEW.status IN ('ESTABLISHED', 'RETIRED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity lifecycle transition denied', CONSTRAINT = 'identity_lifecycle_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION identity.enforce_document_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'CURRENT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial document state', CONSTRAINT = 'identity_document_lifecycle';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.identity_id IS DISTINCT FROM NEW.identity_id
    OR OLD.country_code IS DISTINCT FROM NEW.country_code
    OR OLD.issuer_code IS DISTINCT FROM NEW.issuer_code
    OR OLD.document_type IS DISTINCT FROM NEW.document_type
    OR OLD.normalization_profile IS DISTINCT FROM NEW.normalization_profile
    OR OLD.encryption_algorithm IS DISTINCT FROM NEW.encryption_algorithm
    OR OLD.encryption_schema_version IS DISTINCT FROM NEW.encryption_schema_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable identity document fields changed', CONSTRAINT = 'identity_document_immutable_fields';
  END IF;

  IF OLD.state = NEW.state THEN
    IF OLD.ciphertext IS DISTINCT FROM NEW.ciphertext
      OR OLD.nonce IS DISTINCT FROM NEW.nonce
      OR OLD.authentication_tag IS DISTINCT FROM NEW.authentication_tag
      OR OLD.superseded_at IS DISTINCT FROM NEW.superseded_at
      OR OLD.cryptoshredded_at IS DISTINCT FROM NEW.cryptoshredded_at
      OR NEW.updated_at < OLD.updated_at
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'document update is not an authenticated DEK rewrap', CONSTRAINT = 'identity_document_immutable_fields';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'CURRENT' AND NEW.state IN ('SUPERSEDED', 'REVOKED', 'CRYPTOSHREDDED'))
    OR (OLD.state IN ('SUPERSEDED', 'REVOKED') AND NEW.state = 'CRYPTOSHREDDED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity document lifecycle transition denied', CONSTRAINT = 'identity_document_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION identity.enforce_fingerprint_claim_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'RESERVED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial fingerprint claim state', CONSTRAINT = 'document_fingerprint_claim_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.document_id IS DISTINCT FROM NEW.document_id
    OR OLD.country_code IS DISTINCT FROM NEW.country_code
    OR OLD.issuer_code IS DISTINCT FROM NEW.issuer_code
    OR OLD.document_type IS DISTINCT FROM NEW.document_type
    OR OLD.normalization_profile IS DISTINCT FROM NEW.normalization_profile
    OR OLD.hmac_algorithm IS DISTINCT FROM NEW.hmac_algorithm
    OR OLD.hmac_key_version IS DISTINCT FROM NEW.hmac_key_version
    OR OLD.fingerprint IS DISTINCT FROM NEW.fingerprint
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable fingerprint claim fields changed', CONSTRAINT = 'document_fingerprint_claim_immutable_fields';
  END IF;
  IF NOT (
    (OLD.state = 'RESERVED' AND NEW.state IN ('BOUND', 'TOMBSTONED', 'ABANDONED'))
    OR (OLD.state = 'BOUND' AND NEW.state = 'TOMBSTONED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fingerprint claim lifecycle transition denied', CONSTRAINT = 'document_fingerprint_claim_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION identity.enforce_verification_case_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial verification case state', CONSTRAINT = 'verification_case_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.identity_id IS DISTINCT FROM NEW.identity_id
    OR OLD.previous_case_id IS DISTINCT FROM NEW.previous_case_id
    OR OLD.method_class IS DISTINCT FROM NEW.method_class
    OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
    OR OLD.opened_at IS DISTINCT FROM NEW.opened_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.status <> 'PENDING'
    OR NEW.status NOT IN ('VERIFIED', 'FAILED', 'INCONCLUSIVE', 'EXPIRED', 'CANCELLED')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'verification case lifecycle transition denied', CONSTRAINT = 'verification_case_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION identity.enforce_review_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('NOT_REQUIRED', 'QUEUED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial review state', CONSTRAINT = 'identity_review_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.case_id IS DISTINCT FROM NEW.case_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.policy_version IS DISTINCT FROM NEW.policy_version
    OR NEW.updated_at < OLD.updated_at
    OR NOT (
      (OLD.state = 'QUEUED' AND NEW.state IN ('IN_REVIEW', 'CANCELLED'))
      OR (OLD.state = 'IN_REVIEW' AND NEW.state IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity review lifecycle transition denied', CONSTRAINT = 'identity_review_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION accounts.require_account_transition_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expected_from varchar(32);
BEGIN
  expected_from := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
  IF NOT EXISTS (
    SELECT 1
    FROM accounts.account_status_transitions transition
    WHERE transition.account_id = NEW.id
      AND transition.aggregate_version = NEW.version
      AND transition.from_status IS NOT DISTINCT FROM expected_from
      AND transition.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account transition evidence is required', CONSTRAINT = 'account_transition_evidence_required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION identity.require_identity_transition_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expected_from varchar(24);
BEGIN
  expected_from := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
  IF NOT EXISTS (
    SELECT 1
    FROM identity.identity_status_transitions transition
    WHERE transition.identity_id = NEW.id
      AND transition.aggregate_version = NEW.version
      AND transition.from_status IS NOT DISTINCT FROM expected_from
      AND transition.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity transition evidence is required', CONSTRAINT = 'identity_transition_evidence_required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION accounts.require_active_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  established_count integer;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN RETURN NULL; END IF;
  SELECT count(*)::integer INTO established_count
  FROM identity.person_identities person_identity
  WHERE person_identity.account_id = NEW.id AND person_identity.status = 'ESTABLISHED';
  IF established_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM identity.person_identities person_identity
    JOIN identity.identity_documents document ON document.identity_id = person_identity.id
    JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
    WHERE person_identity.account_id = NEW.id
      AND document.state = 'CURRENT'
      AND claim.state = 'BOUND'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active account requires one established identity and bound claim', CONSTRAINT = 'account_active_identity_required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION identity.require_establishment_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'ESTABLISHED' THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM identity.verification_cases verification_case
    JOIN identity.identity_reviews review ON review.case_id = verification_case.id
    WHERE verification_case.identity_id = NEW.id
      AND verification_case.status = 'VERIFIED'
      AND review.state IN ('NOT_REQUIRED', 'APPROVED')
  ) OR NOT EXISTS (
    SELECT 1
    FROM identity.identity_documents document
    JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
    WHERE document.identity_id = NEW.id
      AND document.state = 'CURRENT'
      AND claim.state = 'BOUND'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity establishment evidence is required', CONSTRAINT = 'identity_establishment_evidence_required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION accounts.reject_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account transition history is append-only', CONSTRAINT = 'account_transition_append_only';
END;
$$;

CREATE FUNCTION identity.reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity evidence/history is append-only', CONSTRAINT = 'identity_evidence_append_only';
END;
$$;

REVOKE ALL ON FUNCTION accounts.enforce_account_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.require_account_transition_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.require_active_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounts.reject_transition_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.enforce_identity_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.enforce_document_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.enforce_fingerprint_claim_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.enforce_verification_case_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.enforce_review_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.require_identity_transition_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.require_establishment_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.reject_evidence_mutation() FROM PUBLIC;

CREATE TRIGGER enforce_account_lifecycle
BEFORE INSERT OR UPDATE ON accounts.accounts
FOR EACH ROW EXECUTE FUNCTION accounts.enforce_account_lifecycle();
CREATE CONSTRAINT TRIGGER require_account_transition_evidence
AFTER INSERT OR UPDATE ON accounts.accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounts.require_account_transition_evidence();
CREATE CONSTRAINT TRIGGER require_active_identity
AFTER INSERT OR UPDATE ON accounts.accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounts.require_active_identity();
CREATE TRIGGER reject_account_transition_mutation
BEFORE UPDATE OR DELETE ON accounts.account_status_transitions
FOR EACH ROW EXECUTE FUNCTION accounts.reject_transition_mutation();

CREATE TRIGGER enforce_identity_lifecycle
BEFORE INSERT OR UPDATE ON identity.person_identities
FOR EACH ROW EXECUTE FUNCTION identity.enforce_identity_lifecycle();
CREATE CONSTRAINT TRIGGER require_identity_transition_evidence
AFTER INSERT OR UPDATE ON identity.person_identities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION identity.require_identity_transition_evidence();
CREATE CONSTRAINT TRIGGER require_establishment_evidence
AFTER INSERT OR UPDATE ON identity.person_identities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION identity.require_establishment_evidence();
CREATE TRIGGER reject_identity_transition_mutation
BEFORE UPDATE OR DELETE ON identity.identity_status_transitions
FOR EACH ROW EXECUTE FUNCTION identity.reject_evidence_mutation();
CREATE TRIGGER enforce_identity_document_lifecycle
BEFORE INSERT OR UPDATE ON identity.identity_documents
FOR EACH ROW EXECUTE FUNCTION identity.enforce_document_lifecycle();
CREATE TRIGGER enforce_fingerprint_claim_lifecycle
BEFORE INSERT OR UPDATE ON identity.document_fingerprint_claims
FOR EACH ROW EXECUTE FUNCTION identity.enforce_fingerprint_claim_lifecycle();
CREATE TRIGGER enforce_verification_case_lifecycle
BEFORE INSERT OR UPDATE ON identity.verification_cases
FOR EACH ROW EXECUTE FUNCTION identity.enforce_verification_case_lifecycle();
CREATE TRIGGER enforce_identity_review_lifecycle
BEFORE INSERT OR UPDATE ON identity.identity_reviews
FOR EACH ROW EXECUTE FUNCTION identity.enforce_review_lifecycle();
CREATE TRIGGER reject_verification_evidence_mutation
BEFORE UPDATE OR DELETE ON identity.verification_evidence
FOR EACH ROW EXECUTE FUNCTION identity.reject_evidence_mutation();

REVOKE ALL ON TABLE identity.verification_cases, identity.verification_evidence, identity.identity_reviews FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE identity.verification_cases TO trayvi_runtime;
GRANT UPDATE (decision_id, status, result_code, resolved_at)
  ON TABLE identity.verification_cases TO trayvi_runtime;
GRANT INSERT ON TABLE identity.verification_evidence TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE identity.identity_reviews TO trayvi_runtime;
GRANT UPDATE (
  state,
  actor_class,
  actor_reference,
  reason_code,
  evidence_reference,
  updated_at,
  resolved_at
) ON TABLE identity.identity_reviews TO trayvi_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE identity.verification_cases, identity.verification_evidence, identity.identity_reviews
  FROM trayvi_runtime;
