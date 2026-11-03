-- Purpose: SPEC-001 ws-c. Rate-limit buckets keyed by an HMAC commitment of the subject (PLAN §11),
-- so stored rows reveal no phone number, IP address, installation, or account. Each decision is
-- one atomic statement over the current and previous fixed window.
-- Lock/rewrite risk: new table only.
-- Rollback: paired down migration refuses to drop the table while it holds rows.
CREATE TABLE auth.rate_limit_buckets (
  dimension varchar(64) NOT NULL,
  subject bytea NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (dimension, subject, window_start),
  CONSTRAINT rate_limit_dimension_valid CHECK (
    dimension IN (
      'CHALLENGE_START_CONTACT_HOUR', 'CHALLENGE_START_CONTACT_DAY',
      'CHALLENGE_START_NETWORK_HOUR', 'CHALLENGE_START_INSTALLATION_HOUR',
      'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', 'PASSWORD_FAILURE_ACCOUNT',
      'PASSWORD_FAILURE_NETWORK_HOUR', 'RECOVERY_START_ACCOUNT_DAY', 'RECOVERY_START_NETWORK_HOUR',
      'REGISTRATION_START_CONTACT_30D', 'REGISTRATION_START_NETWORK_DAY',
      'REVERIFICATION_GLOBAL_HOUR', 'DELIVERY_GLOBAL_MINUTE'
    )
  ),
  CONSTRAINT rate_limit_subject_commitment CHECK (octet_length(subject) = 32),
  CONSTRAINT rate_limit_count_nonnegative CHECK (count >= 0)
);

-- Pruning expired windows scans by window start.
CREATE INDEX rate_limit_bucket_window_start ON auth.rate_limit_buckets (window_start);

REVOKE ALL ON TABLE auth.rate_limit_buckets FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE auth.rate_limit_buckets TO trayvi_runtime;
GRANT UPDATE (count) ON TABLE auth.rate_limit_buckets TO trayvi_runtime;
