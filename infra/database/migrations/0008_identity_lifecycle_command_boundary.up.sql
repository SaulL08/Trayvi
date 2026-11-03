-- Purpose: remediate P1-AUD-001 and P1-AUD-003. Material identity/account transitions move behind one
-- SECURITY DEFINER command that binds evidence to its case and emits the activation outbox atomically;
-- the general runtime loses direct lifecycle writes and may append only initial transition history.
-- Lock/rewrite risk: privilege, policy, constraint, and function changes under brief locks; the new
-- composite foreign key validates existing review rows without rewriting them.
-- Rollback: paired down migration restores the Phase 1 grants, guard definitions, and ownership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_lifecycle_owner')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_verification')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = 'run infra/database/bootstrap/0001_roles.sql before migration 0008';
  END IF;
END;
$$;

-- P1-AUD-003: a review may only cite evidence collected for its own verification case.
ALTER TABLE identity.verification_evidence
  ADD CONSTRAINT verification_evidence_case_binding_unique UNIQUE (id, case_id);
ALTER TABLE identity.identity_reviews
  ADD CONSTRAINT identity_review_evidence_same_case
  FOREIGN KEY (evidence_reference, case_id)
  REFERENCES identity.verification_evidence (id, case_id) ON DELETE RESTRICT;

-- Establishment additionally requires the transition to cite evidence of a verified, reviewed case
-- belonging to the same identity.
CREATE OR REPLACE FUNCTION identity.require_establishment_evidence()
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
    JOIN identity.verification_evidence evidence
      ON evidence.id = review.evidence_reference AND evidence.case_id = verification_case.id
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
  IF TG_OP = 'UPDATE' AND OLD.status = 'PENDING' AND NOT EXISTS (
    SELECT 1
    FROM identity.identity_status_transitions transition
    JOIN identity.verification_evidence evidence ON evidence.id = transition.evidence_reference
    JOIN identity.verification_cases verification_case ON verification_case.id = evidence.case_id
    JOIN identity.identity_reviews review
      ON review.case_id = verification_case.id AND review.evidence_reference = evidence.id
    WHERE transition.identity_id = NEW.id
      AND transition.aggregate_version = NEW.version
      AND transition.to_status = 'ESTABLISHED'
      AND verification_case.identity_id = NEW.id
      AND verification_case.status = 'VERIFIED'
      AND review.state IN ('NOT_REQUIRED', 'APPROVED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity establishment must cite its own case evidence', CONSTRAINT = 'identity_establishment_evidence_binding';
  END IF;
  RETURN NULL;
END;
$$;

-- Deferred guards must not depend on the privileges of whichever session commits.
ALTER FUNCTION accounts.require_account_transition_evidence() SECURITY DEFINER;
ALTER FUNCTION accounts.require_active_identity() SECURITY DEFINER;
ALTER FUNCTION identity.require_identity_transition_evidence() SECURITY DEFINER;
ALTER FUNCTION identity.require_establishment_evidence() SECURITY DEFINER;
REVOKE ALL ON FUNCTION identity.require_establishment_evidence() FROM PUBLIC;

-- P1-AUD-001: the general runtime can no longer write lifecycle state, verification, or review rows.
REVOKE UPDATE ON TABLE accounts.accounts FROM trayvi_runtime;
REVOKE UPDATE (status, status_reason_code, version, updated_at, closed_at)
  ON TABLE accounts.accounts FROM trayvi_runtime;
REVOKE UPDATE ON TABLE identity.person_identities FROM trayvi_runtime;
REVOKE UPDATE (
  status,
  status_reason_code,
  version,
  updated_at,
  established_at,
  restricted_at,
  retired_at
) ON TABLE identity.person_identities FROM trayvi_runtime;
REVOKE UPDATE ON TABLE identity.document_fingerprint_claims FROM trayvi_runtime;
REVOKE UPDATE (state, bound_at, tombstoned_at, abandoned_at)
  ON TABLE identity.document_fingerprint_claims FROM trayvi_runtime;
REVOKE INSERT, UPDATE ON TABLE identity.verification_cases FROM trayvi_runtime;
REVOKE UPDATE (decision_id, status, result_code, resolved_at)
  ON TABLE identity.verification_cases FROM trayvi_runtime;
REVOKE INSERT ON TABLE identity.verification_evidence FROM trayvi_runtime;
REVOKE INSERT, UPDATE ON TABLE identity.identity_reviews FROM trayvi_runtime;
REVOKE UPDATE (
  state,
  actor_class,
  actor_reference,
  reason_code,
  evidence_reference,
  updated_at,
  resolved_at
) ON TABLE identity.identity_reviews FROM trayvi_runtime;

-- Runtime may append only the initial enrollment history row; later history belongs to commands.
ALTER TABLE accounts.account_status_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.identity_status_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY runtime_read ON accounts.account_status_transitions
  FOR SELECT TO trayvi_runtime USING (true);
CREATE POLICY runtime_initial_only ON accounts.account_status_transitions
  FOR INSERT TO trayvi_runtime
  WITH CHECK (from_status IS NULL AND to_status = 'PENDING_IDENTITY' AND aggregate_version = 0);
CREATE POLICY lifecycle_command ON accounts.account_status_transitions
  FOR ALL TO trayvi_lifecycle_owner USING (true) WITH CHECK (true);
CREATE POLICY runtime_read ON identity.identity_status_transitions
  FOR SELECT TO trayvi_runtime USING (true);
CREATE POLICY runtime_initial_only ON identity.identity_status_transitions
  FOR INSERT TO trayvi_runtime
  WITH CHECK (from_status IS NULL AND to_status = 'PENDING' AND aggregate_version = 0);
CREATE POLICY lifecycle_command ON identity.identity_status_transitions
  FOR ALL TO trayvi_lifecycle_owner USING (true) WITH CHECK (true);

-- Minimum privileges for the command owner.
GRANT USAGE ON SCHEMA accounts, identity, platform TO trayvi_lifecycle_owner;
GRANT SELECT ON TABLE
  accounts.accounts,
  accounts.account_status_transitions,
  identity.person_identities,
  identity.identity_status_transitions,
  identity.verification_cases,
  identity.verification_evidence,
  identity.identity_reviews
TO trayvi_lifecycle_owner;
GRANT SELECT (id, identity_id, state) ON TABLE identity.identity_documents TO trayvi_lifecycle_owner;
GRANT SELECT (id, document_id, state) ON TABLE identity.document_fingerprint_claims
  TO trayvi_lifecycle_owner;
GRANT UPDATE (status, status_reason_code, version, updated_at)
  ON TABLE accounts.accounts TO trayvi_lifecycle_owner;
GRANT UPDATE (status, status_reason_code, version, updated_at, established_at)
  ON TABLE identity.person_identities TO trayvi_lifecycle_owner;
GRANT UPDATE (state, bound_at) ON TABLE identity.document_fingerprint_claims
  TO trayvi_lifecycle_owner;
GRANT UPDATE (decision_id, status, result_code, resolved_at)
  ON TABLE identity.verification_cases TO trayvi_lifecycle_owner;
GRANT INSERT ON TABLE
  accounts.account_status_transitions,
  identity.identity_status_transitions,
  identity.verification_cases,
  identity.verification_evidence,
  identity.identity_reviews,
  platform.outbox_events
TO trayvi_lifecycle_owner;

CREATE FUNCTION identity.record_trusted_verification(
  p_decision_id uuid,
  p_identity_id uuid,
  p_case_id uuid,
  p_evidence_id uuid,
  p_review_id uuid,
  p_identity_transition_id uuid,
  p_account_transition_id uuid,
  p_identity_event_id uuid,
  p_account_event_id uuid,
  p_method_class varchar,
  p_result_code varchar,
  p_policy_version varchar,
  p_provider_alias varchar,
  p_evidence_type varchar,
  p_evidence_digest bytea,
  p_restricted_reference varchar,
  p_retention_class varchar,
  p_actor_reference varchar,
  p_occurred_at timestamptz,
  p_correlation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target record;
  target_found boolean;
  decided_identity uuid;
  bound_count integer;
BEGIN
  IF p_evidence_digest IS NULL OR octet_length(p_evidence_digest) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_VERIFICATION_EVIDENCE';
  END IF;

  SELECT person_identity.id AS identity_id,
         person_identity.status AS identity_status,
         person_identity.version AS identity_version,
         account.id AS account_id,
         account.status AS account_status,
         account.version AS account_version
  INTO target
  FROM identity.person_identities person_identity
  JOIN accounts.accounts account ON account.id = person_identity.account_id
  WHERE person_identity.id = p_identity_id
  FOR UPDATE OF person_identity, account;
  target_found := FOUND;

  -- Checked after the aggregate lock so a concurrent replay observes the committed decision.
  SELECT verification_case.identity_id INTO decided_identity
  FROM identity.verification_cases verification_case
  WHERE verification_case.decision_id = p_decision_id
  FOR UPDATE;
  IF FOUND THEN
    IF decided_identity <> p_identity_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VERIFICATION_DECISION_REUSE';
    END IF;
    RETURN 'REPLAY';
  END IF;

  IF NOT target_found THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VERIFICATION_TARGET_UNAVAILABLE';
  END IF;
  IF target.identity_status <> 'PENDING' OR target.account_status <> 'PENDING_IDENTITY' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VERIFICATION_TARGET_UNAVAILABLE';
  END IF;

  INSERT INTO identity.verification_cases (
    id, identity_id, method_class, status, policy_version, opened_at, expires_at
  ) VALUES (
    p_case_id, p_identity_id, p_method_class, 'PENDING', p_policy_version,
    p_occurred_at, p_occurred_at + interval '15 minutes'
  );
  INSERT INTO identity.verification_evidence (
    id, case_id, evidence_type, provider_alias, collected_at,
    digest_algorithm, evidence_digest, restricted_reference, retention_class, created_at
  ) VALUES (
    p_evidence_id, p_case_id, p_evidence_type, p_provider_alias, p_occurred_at,
    'sha-256', p_evidence_digest, p_restricted_reference, p_retention_class, p_occurred_at
  );
  INSERT INTO identity.identity_reviews (
    id, case_id, state, actor_class, actor_reference, reason_code,
    evidence_reference, policy_version, created_at, updated_at, resolved_at
  ) VALUES (
    p_review_id, p_case_id, 'NOT_REQUIRED', 'POLICY_ENGINE', p_actor_reference,
    'TRUSTED_VERIFICATION_ACCEPTED', p_evidence_id, p_policy_version,
    p_occurred_at, p_occurred_at, p_occurred_at
  );
  UPDATE identity.verification_cases
  SET decision_id = p_decision_id, status = 'VERIFIED', result_code = p_result_code,
      resolved_at = p_occurred_at
  WHERE id = p_case_id AND status = 'PENDING';

  UPDATE identity.document_fingerprint_claims claim
  SET state = 'BOUND', bound_at = p_occurred_at
  FROM identity.identity_documents document
  WHERE claim.document_id = document.id
    AND document.identity_id = p_identity_id
    AND document.state = 'CURRENT'
    AND claim.state = 'RESERVED';
  GET DIAGNOSTICS bound_count = ROW_COUNT;
  IF bound_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VERIFICATION_CLAIM_MISSING';
  END IF;

  UPDATE identity.person_identities
  SET status = 'ESTABLISHED', status_reason_code = 'IDENTITY_ESTABLISHED',
      version = target.identity_version + 1, updated_at = p_occurred_at,
      established_at = p_occurred_at
  WHERE id = p_identity_id AND version = target.identity_version;
  INSERT INTO identity.identity_status_transitions (
    id, identity_id, from_status, to_status, aggregate_version,
    actor_class, actor_reference, reason_code, evidence_reference, occurred_at
  ) VALUES (
    p_identity_transition_id, p_identity_id, 'PENDING', 'ESTABLISHED',
    target.identity_version + 1, 'TRUSTED_VERIFICATION_HANDLER', p_actor_reference,
    'IDENTITY_ESTABLISHED', p_evidence_id, p_occurred_at
  );

  UPDATE accounts.accounts
  SET status = 'ACTIVE', status_reason_code = 'IDENTITY_ESTABLISHED',
      version = target.account_version + 1, updated_at = p_occurred_at
  WHERE id = target.account_id AND version = target.account_version;
  INSERT INTO accounts.account_status_transitions (
    id, account_id, from_status, to_status, aggregate_version,
    actor_class, actor_reference, reason_code, evidence_reference, occurred_at
  ) VALUES (
    p_account_transition_id, target.account_id, 'PENDING_IDENTITY', 'ACTIVE',
    target.account_version + 1, 'TRUSTED_VERIFICATION_HANDLER', p_actor_reference,
    'IDENTITY_ESTABLISHED', p_evidence_id, p_occurred_at
  );

  INSERT INTO platform.outbox_events (
    id, event_type, schema_version, aggregate_type, aggregate_id,
    occurred_at, correlation_id, causation_id, payload
  ) VALUES
    (
      p_identity_event_id, 'identity.established', 1, 'identity', p_identity_id,
      p_occurred_at, p_correlation_id, p_decision_id,
      jsonb_build_object(
        'identityId', p_identity_id::text,
        'accountId', target.account_id::text,
        'state', 'ESTABLISHED'
      )
    ),
    (
      p_account_event_id, 'account.activated', 1, 'account', target.account_id,
      p_occurred_at, p_correlation_id, p_decision_id,
      jsonb_build_object('accountId', target.account_id::text, 'state', 'ACTIVE')
    );

  RETURN 'RECORDED';
END;
$$;

REVOKE ALL ON FUNCTION identity.record_trusted_verification(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, varchar, varchar, varchar, varchar,
  varchar, bytea, varchar, varchar, varchar, timestamptz, uuid
) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO trayvi_verification;
GRANT EXECUTE ON FUNCTION identity.record_trusted_verification(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, varchar, varchar, varchar, varchar,
  varchar, bytea, varchar, varchar, varchar, timestamptz, uuid
) TO trayvi_verification;

ALTER FUNCTION accounts.require_account_transition_evidence() OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION accounts.require_active_identity() OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION identity.require_identity_transition_evidence() OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION identity.require_establishment_evidence() OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION identity.record_trusted_verification(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, varchar, varchar, varchar, varchar,
  varchar, bytea, varchar, varchar, varchar, timestamptz, uuid
) OWNER TO trayvi_lifecycle_owner;
