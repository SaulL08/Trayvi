-- Rollback: restore the migration 0007 grants, guard definitions, and ownership. No rows are removed,
-- but the command boundary may only be removed from an entirely empty Phase 1 domain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts.account_creation_operations LIMIT 1)
    OR EXISTS (SELECT 1 FROM accounts.accounts LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.person_identities LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.identity_documents LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.document_fingerprint_claims LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.verification_cases LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.verification_evidence LIMIT 1)
    OR EXISTS (SELECT 1 FROM identity.identity_reviews LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'refusing to remove the Phase 1 lifecycle command boundary from a populated domain';
  END IF;
END;
$$;

DROP FUNCTION identity.record_trusted_verification(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, varchar, varchar, varchar, varchar,
  varchar, bytea, varchar, varchar, varchar, timestamptz, uuid
);
REVOKE USAGE ON SCHEMA identity FROM trayvi_verification;

ALTER FUNCTION accounts.require_account_transition_evidence() OWNER TO CURRENT_USER;
ALTER FUNCTION accounts.require_active_identity() OWNER TO CURRENT_USER;
ALTER FUNCTION identity.require_identity_transition_evidence() OWNER TO CURRENT_USER;
ALTER FUNCTION identity.require_establishment_evidence() OWNER TO CURRENT_USER;
ALTER FUNCTION accounts.require_account_transition_evidence() SECURITY INVOKER;
ALTER FUNCTION accounts.require_active_identity() SECURITY INVOKER;
ALTER FUNCTION identity.require_identity_transition_evidence() SECURITY INVOKER;
ALTER FUNCTION identity.require_establishment_evidence() SECURITY INVOKER;

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

REVOKE ALL ON TABLE
  accounts.accounts,
  accounts.account_status_transitions,
  identity.person_identities,
  identity.identity_status_transitions,
  identity.verification_cases,
  identity.verification_evidence,
  identity.identity_reviews,
  identity.identity_documents,
  identity.document_fingerprint_claims,
  platform.outbox_events
FROM trayvi_lifecycle_owner;
REVOKE USAGE ON SCHEMA accounts, identity, platform FROM trayvi_lifecycle_owner;

DROP POLICY lifecycle_command ON identity.identity_status_transitions;
DROP POLICY runtime_initial_only ON identity.identity_status_transitions;
DROP POLICY runtime_read ON identity.identity_status_transitions;
DROP POLICY lifecycle_command ON accounts.account_status_transitions;
DROP POLICY runtime_initial_only ON accounts.account_status_transitions;
DROP POLICY runtime_read ON accounts.account_status_transitions;
ALTER TABLE identity.identity_status_transitions DISABLE ROW LEVEL SECURITY;
ALTER TABLE accounts.account_status_transitions DISABLE ROW LEVEL SECURITY;

GRANT UPDATE (status, status_reason_code, version, updated_at, closed_at)
  ON TABLE accounts.accounts TO trayvi_runtime;
GRANT UPDATE (
  status,
  status_reason_code,
  version,
  updated_at,
  established_at,
  restricted_at,
  retired_at
) ON TABLE identity.person_identities TO trayvi_runtime;
GRANT UPDATE (state, bound_at, tombstoned_at, abandoned_at)
  ON TABLE identity.document_fingerprint_claims TO trayvi_runtime;
GRANT INSERT ON TABLE identity.verification_cases TO trayvi_runtime;
GRANT UPDATE (decision_id, status, result_code, resolved_at)
  ON TABLE identity.verification_cases TO trayvi_runtime;
GRANT INSERT ON TABLE identity.verification_evidence TO trayvi_runtime;
GRANT INSERT ON TABLE identity.identity_reviews TO trayvi_runtime;
GRANT UPDATE (
  state,
  actor_class,
  actor_reference,
  reason_code,
  evidence_reference,
  updated_at,
  resolved_at
) ON TABLE identity.identity_reviews TO trayvi_runtime;

ALTER TABLE identity.identity_reviews DROP CONSTRAINT identity_review_evidence_same_case;
ALTER TABLE identity.verification_evidence
  DROP CONSTRAINT verification_evidence_case_binding_unique;
