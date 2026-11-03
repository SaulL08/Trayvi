-- Purpose: SPEC-001 ws-b. OTP verification challenges and the single-use contact proofs a verified
-- challenge creates. A challenge stores only the destination fingerprint and a keyed commitment of
-- the code (PLAN §§7.3, 8.1); a proof stores only the SHA-256 of its opaque token (PLAN §9.1).
-- Lock/rewrite risk: new tables, indexes, functions, and triggers only; no existing rows change.
-- Rollback: paired down migration refuses to drop populated tables.
CREATE TABLE auth.verification_challenges (
  id uuid PRIMARY KEY,
  purpose varchar(32) NOT NULL,
  destination_key_version varchar(64) NOT NULL,
  destination_fingerprint bytea NOT NULL,
  otp_commitment bytea NOT NULL,
  otp_key_version varchar(64) NOT NULL,
  installation_commitment bytea NOT NULL,
  failed_attempts smallint NOT NULL,
  max_failed_attempts smallint NOT NULL,
  resend_count smallint NOT NULL,
  max_resends smallint NOT NULL,
  last_sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivery_outcome_code varchar(32),
  state varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT verification_challenge_purpose_valid CHECK (
    purpose IN ('CONTACT_PROOF', 'STEP_UP', 'RECOVERY_NEW_CONTACT', 'RECOVERY_CANCEL', 'CONTACT_CHANGE_NEW')
  ),
  CONSTRAINT verification_challenge_key_version_format CHECK (
    destination_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND otp_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT verification_challenge_commitment_lengths CHECK (
    octet_length(destination_fingerprint) = 32
    AND octet_length(otp_commitment) = 32
    AND octet_length(installation_commitment) = 32
  ),
  CONSTRAINT verification_challenge_attempts_bounded CHECK (
    max_failed_attempts BETWEEN 3 AND 10 AND failed_attempts BETWEEN 0 AND max_failed_attempts
  ),
  CONSTRAINT verification_challenge_resends_bounded CHECK (
    max_resends BETWEEN 0 AND 5 AND resend_count BETWEEN 0 AND max_resends
  ),
  CONSTRAINT verification_challenge_lifetime_bounded CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT verification_challenge_delivery_outcome_valid CHECK (
    delivery_outcome_code IS NULL OR delivery_outcome_code IN (
      'SENT', 'BUDGET_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
      'TIMEOUT', 'DELIVERED', 'UNDELIVERED'
    )
  ),
  CONSTRAINT verification_challenge_state_valid CHECK (
    state IN ('PENDING', 'VERIFIED', 'CONSUMED', 'EXPIRED', 'EXHAUSTED', 'CANCELLED')
  ),
  CONSTRAINT verification_challenge_exhausted_at_cap CHECK (
    state <> 'EXHAUSTED' OR failed_attempts = max_failed_attempts
  ),
  CONSTRAINT verification_challenge_pending_below_cap CHECK (
    state <> 'PENDING' OR failed_attempts < max_failed_attempts
  )
);

-- R-16: at most one PENDING challenge per destination and purpose.
CREATE UNIQUE INDEX verification_challenge_pending_unique
  ON auth.verification_challenges (purpose, destination_key_version, destination_fingerprint)
  WHERE state = 'PENDING';

CREATE TABLE auth.contact_proofs (
  id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES auth.verification_challenges (id) ON DELETE RESTRICT,
  purpose varchar(32) NOT NULL,
  destination_key_version varchar(64) NOT NULL,
  destination_fingerprint bytea NOT NULL,
  proof_hash bytea NOT NULL UNIQUE,
  installation_commitment bytea NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT contact_proof_lengths CHECK (
    octet_length(destination_fingerprint) = 32
    AND octet_length(proof_hash) = 32
    AND octet_length(installation_commitment) = 32
  ),
  CONSTRAINT contact_proof_lifetime_bounded CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
  ),
  CONSTRAINT contact_proof_consumed_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

-- R-12: PLAN §5.3 edges; counters only grow by one; identity and limits are immutable. A new code
-- (otp_commitment change) is allowed only together with a resend while PENDING.
CREATE FUNCTION auth.enforce_verification_challenge_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' OR NEW.failed_attempts <> 0 OR NEW.resend_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial challenge state', CONSTRAINT = 'verification_challenge_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.purpose, OLD.destination_key_version, OLD.destination_fingerprint,
      OLD.installation_commitment, OLD.max_failed_attempts, OLD.max_resends, OLD.expires_at,
      OLD.created_at)
    IS DISTINCT FROM
     (NEW.id, NEW.purpose, NEW.destination_key_version, NEW.destination_fingerprint,
      NEW.installation_commitment, NEW.max_failed_attempts, NEW.max_resends, NEW.expires_at,
      NEW.created_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable challenge fields changed', CONSTRAINT = 'verification_challenge_immutable_fields';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'PENDING' AND NEW.state IN ('VERIFIED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.state = 'VERIFIED' AND NEW.state IN ('CONSUMED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'challenge lifecycle transition denied', CONSTRAINT = 'verification_challenge_lifecycle';
  END IF;
  IF NEW.failed_attempts NOT IN (OLD.failed_attempts, OLD.failed_attempts + 1)
    OR NEW.resend_count NOT IN (OLD.resend_count, OLD.resend_count + 1)
    OR (OLD.state <> 'PENDING' AND (
      NEW.failed_attempts <> OLD.failed_attempts OR NEW.resend_count <> OLD.resend_count
    ))
    OR ((NEW.otp_commitment, NEW.otp_key_version, NEW.last_sent_at)
          IS DISTINCT FROM (OLD.otp_commitment, OLD.otp_key_version, OLD.last_sent_at)
        AND NOT (OLD.state = 'PENDING' AND NEW.state = 'PENDING'
                 AND NEW.resend_count = OLD.resend_count + 1))
    OR (NEW.resend_count = OLD.resend_count + 1 AND NEW.otp_commitment = OLD.otp_commitment)
    OR (NEW.state = 'VERIFIED' AND NEW.failed_attempts <> OLD.failed_attempts)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'challenge counter transition denied', CONSTRAINT = 'verification_challenge_counters';
  END IF;
  RETURN NEW;
END;
$$;

-- R-14: a proof is consumed at most once and nothing else about it changes.
CREATE FUNCTION auth.enforce_contact_proof_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial proof state', CONSTRAINT = 'contact_proof_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.challenge_id, OLD.purpose, OLD.destination_key_version,
      OLD.destination_fingerprint, OLD.proof_hash, OLD.installation_commitment, OLD.created_at,
      OLD.expires_at)
    IS DISTINCT FROM
     (NEW.id, NEW.challenge_id, NEW.purpose, NEW.destination_key_version,
      NEW.destination_fingerprint, NEW.proof_hash, NEW.installation_commitment, NEW.created_at,
      NEW.expires_at)
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contact proof lifecycle transition denied', CONSTRAINT = 'contact_proof_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_verification_challenge_lifecycle
BEFORE INSERT OR UPDATE ON auth.verification_challenges
FOR EACH ROW EXECUTE FUNCTION auth.enforce_verification_challenge_lifecycle();
CREATE TRIGGER enforce_contact_proof_lifecycle
BEFORE INSERT OR UPDATE ON auth.contact_proofs
FOR EACH ROW EXECUTE FUNCTION auth.enforce_contact_proof_lifecycle();

REVOKE ALL ON FUNCTION auth.enforce_verification_challenge_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_contact_proof_lifecycle() FROM PUBLIC;
REVOKE ALL ON TABLE auth.verification_challenges, auth.contact_proofs FROM PUBLIC;

-- Runtime (design §2.2): SELECT, INSERT; UPDATE on state, counter, and time columns only.
GRANT SELECT, INSERT ON TABLE auth.verification_challenges TO trayvi_runtime;
GRANT UPDATE (
  state,
  failed_attempts,
  resend_count,
  otp_commitment,
  otp_key_version,
  last_sent_at,
  delivery_outcome_code,
  updated_at
) ON TABLE auth.verification_challenges TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE auth.contact_proofs TO trayvi_runtime;
GRANT UPDATE (consumed_at) ON TABLE auth.contact_proofs TO trayvi_runtime;
