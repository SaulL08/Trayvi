-- Rollback: lifecycle guards may only be removed from an entirely empty Phase 1 domain.
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
      MESSAGE = 'refusing to remove Phase 1 lifecycle guards from a populated domain';
  END IF;
END;
$$;

REVOKE ALL ON TABLE identity.identity_reviews FROM trayvi_runtime;
REVOKE ALL ON TABLE identity.verification_evidence FROM trayvi_runtime;
REVOKE ALL ON TABLE identity.verification_cases FROM trayvi_runtime;

DROP TRIGGER reject_verification_evidence_mutation ON identity.verification_evidence;
DROP TRIGGER enforce_identity_review_lifecycle ON identity.identity_reviews;
DROP TRIGGER enforce_verification_case_lifecycle ON identity.verification_cases;
DROP TRIGGER enforce_fingerprint_claim_lifecycle ON identity.document_fingerprint_claims;
DROP TRIGGER enforce_identity_document_lifecycle ON identity.identity_documents;
DROP TRIGGER reject_identity_transition_mutation ON identity.identity_status_transitions;
DROP TRIGGER require_establishment_evidence ON identity.person_identities;
DROP TRIGGER require_identity_transition_evidence ON identity.person_identities;
DROP TRIGGER enforce_identity_lifecycle ON identity.person_identities;
DROP TRIGGER reject_account_transition_mutation ON accounts.account_status_transitions;
DROP TRIGGER require_active_identity ON accounts.accounts;
DROP TRIGGER require_account_transition_evidence ON accounts.accounts;
DROP TRIGGER enforce_account_lifecycle ON accounts.accounts;

DROP FUNCTION identity.reject_evidence_mutation();
DROP FUNCTION identity.require_establishment_evidence();
DROP FUNCTION identity.require_identity_transition_evidence();
DROP FUNCTION identity.enforce_review_lifecycle();
DROP FUNCTION identity.enforce_verification_case_lifecycle();
DROP FUNCTION identity.enforce_fingerprint_claim_lifecycle();
DROP FUNCTION identity.enforce_document_lifecycle();
DROP FUNCTION identity.enforce_identity_lifecycle();
DROP FUNCTION accounts.reject_transition_mutation();
DROP FUNCTION accounts.require_active_identity();
DROP FUNCTION accounts.require_account_transition_evidence();
DROP FUNCTION accounts.enforce_account_lifecycle();

DROP TABLE identity.identity_reviews;
DROP TABLE identity.verification_evidence;
DROP TABLE identity.verification_cases;
