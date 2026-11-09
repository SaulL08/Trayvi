-- Purpose: SPEC-002 ws-b. Optional password credentials (PLAN §10): versioned scrypt hashes with a
-- per-credential salt, at most one ACTIVE credential per account, and an append-only history.
-- Lock/rewrite risk: new tables, indexes, functions, and triggers only; no existing rows change.
-- Rollback: paired down migration refuses to drop populated tables.
CREATE TABLE auth.password_credentials (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  algorithm varchar(16) NOT NULL,
  parameter_version varchar(32) NOT NULL,
  salt bytea NOT NULL,
  hash bytea NOT NULL,
  state varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT password_credential_algorithm_valid CHECK (algorithm = 'scrypt'),
  CONSTRAINT password_credential_parameter_version_format CHECK (
    parameter_version ~ '^scrypt-[a-z0-9][a-z0-9.-]{0,24}$'
  ),
  CONSTRAINT password_credential_salt_length CHECK (octet_length(salt) = 16),
  CONSTRAINT password_credential_hash_length CHECK (octet_length(hash) = 32),
  CONSTRAINT password_credential_state_valid CHECK (state IN ('ACTIVE', 'REPLACED', 'REMOVED')),
  CONSTRAINT password_credential_state_fields CHECK ((state = 'ACTIVE') = (ended_at IS NULL))
);

-- R-14: at most one ACTIVE password credential per account.
CREATE UNIQUE INDEX password_credential_one_active_per_account
  ON auth.password_credentials (account_id)
  WHERE state = 'ACTIVE';

CREATE TABLE auth.password_credential_transitions (
  id uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES auth.password_credentials (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  from_state varchar(16),
  to_state varchar(16) NOT NULL,
  reason varchar(16) NOT NULL,
  case_id uuid,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  CONSTRAINT password_transition_edge_valid CHECK (
    (from_state IS NULL AND to_state = 'ACTIVE')
    OR (from_state = 'ACTIVE' AND to_state IN ('REPLACED', 'REMOVED'))
  ),
  CONSTRAINT password_transition_reason_valid CHECK (
    reason IN ('SET', 'CHANGED', 'REHASH', 'RECOVERY')
  ),
  CONSTRAINT password_transition_case_required CHECK ((reason = 'RECOVERY') = (case_id IS NOT NULL))
);

CREATE INDEX password_transition_credential ON auth.password_credential_transitions (credential_id);

-- Only ACTIVE -> REPLACED/REMOVED; every other column is immutable; rows are never deleted.
CREATE FUNCTION auth.enforce_password_credential_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial password credential state', CONSTRAINT = 'password_credential_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'password credentials are not deleted', CONSTRAINT = 'password_credential_retained';
  END IF;
  IF (OLD.id, OLD.account_id, OLD.algorithm, OLD.parameter_version, OLD.salt, OLD.hash,
      OLD.created_at)
    IS DISTINCT FROM
     (NEW.id, NEW.account_id, NEW.algorithm, NEW.parameter_version, NEW.salt, NEW.hash,
      NEW.created_at)
    OR NOT (OLD.state = 'ACTIVE' AND NEW.state IN ('REPLACED', 'REMOVED'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'password credential lifecycle transition denied', CONSTRAINT = 'password_credential_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.reject_password_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'password transitions are append-only', CONSTRAINT = 'password_transition_immutable';
END;
$$;

CREATE TRIGGER enforce_password_credential_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON auth.password_credentials
FOR EACH ROW EXECUTE FUNCTION auth.enforce_password_credential_lifecycle();
CREATE TRIGGER reject_password_transition_mutation
BEFORE UPDATE OR DELETE ON auth.password_credential_transitions
FOR EACH ROW EXECUTE FUNCTION auth.reject_password_transition_mutation();

REVOKE ALL ON FUNCTION auth.enforce_password_credential_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_password_transition_mutation() FROM PUBLIC;

-- Runtime (the Auth workload): read and append credentials, end the active one, append history.
-- Reporting roles get nothing on these tables (SPEC-002 design §2.2).
REVOKE ALL ON TABLE auth.password_credentials, auth.password_credential_transitions FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE auth.password_credentials TO trayvi_runtime;
GRANT UPDATE (state, ended_at) ON TABLE auth.password_credentials TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE auth.password_credential_transitions TO trayvi_runtime;
