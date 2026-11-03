-- Purpose: SPEC-001 ws-a. Phone contact points bound to accounts, one fingerprint row per HMAC key
-- version, an append-only transition history, and the guarded commands that bind and replace a
-- primary contact. The runtime never writes these tables directly: it calls SECURITY DEFINER
-- commands that change state, record the transition, and emit the outbox event atomically.
-- Lock/rewrite risk: new tables, indexes, functions, and triggers only; no existing rows change.
-- Rollback: paired down migration refuses to drop populated tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_lifecycle_owner') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = 'run infra/database/bootstrap/0001_roles.sql before migration 0013';
  END IF;
END;
$$;

CREATE TABLE auth.contact_points (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  channel varchar(16) NOT NULL,
  role varchar(16) NOT NULL,
  normalization_profile varchar(64) NOT NULL,
  key_version varchar(64) NOT NULL,
  fingerprint bytea NOT NULL,
  encryption_algorithm varchar(32) NOT NULL,
  encryption_schema_version smallint NOT NULL,
  kek_key_version varchar(64) NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  state varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  replaced_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT contact_point_channel_valid CHECK (channel = 'PHONE'),
  CONSTRAINT contact_point_role_valid CHECK (role = 'PRIMARY'),
  CONSTRAINT contact_point_profile_valid CHECK (normalization_profile = 'e164-v1'),
  CONSTRAINT contact_point_key_version_format CHECK (
    key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$' AND kek_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT contact_point_fingerprint_length CHECK (octet_length(fingerprint) = 32),
  CONSTRAINT contact_point_envelope_valid CHECK (
    encryption_algorithm = 'aes-256-gcm'
    AND encryption_schema_version = 1
    AND octet_length(ciphertext) BETWEEN 9 AND 16
    AND octet_length(nonce) = 12
    AND octet_length(authentication_tag) = 16
    AND octet_length(wrapped_dek) = 60
  ),
  CONSTRAINT contact_point_state_valid CHECK (state IN ('ACTIVE', 'REPLACED', 'REVOKED')),
  CONSTRAINT contact_point_state_timestamps CHECK (
    (state = 'ACTIVE' AND replaced_at IS NULL AND revoked_at IS NULL)
    OR (state = 'REPLACED' AND replaced_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL AND replaced_at IS NULL)
  )
);

-- One active primary contact per account.
CREATE UNIQUE INDEX contact_point_active_primary_unique
  ON auth.contact_points (account_id)
  WHERE state = 'ACTIVE' AND role = 'PRIMARY';

CREATE TABLE auth.contact_point_fingerprints (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES auth.contact_points (id) ON DELETE RESTRICT,
  channel varchar(16) NOT NULL,
  normalization_profile varchar(64) NOT NULL,
  key_version varchar(64) NOT NULL,
  fingerprint bytea NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL,
  deactivated_at timestamptz,
  CONSTRAINT contact_fingerprint_channel_valid CHECK (channel = 'PHONE'),
  CONSTRAINT contact_fingerprint_profile_valid CHECK (normalization_profile = 'e164-v1'),
  CONSTRAINT contact_fingerprint_key_version_format CHECK (
    key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT contact_fingerprint_length CHECK (octet_length(fingerprint) = 32),
  CONSTRAINT contact_fingerprint_active_timestamps CHECK (active = (deactivated_at IS NULL)),
  CONSTRAINT contact_fingerprint_contact_key_unique UNIQUE (contact_id, key_version)
);

-- R-07: one active binding per (channel, profile, key version, fingerprint) across all accounts.
CREATE UNIQUE INDEX contact_fingerprint_active_unique
  ON auth.contact_point_fingerprints (channel, normalization_profile, key_version, fingerprint)
  WHERE active;

CREATE TABLE auth.contact_point_transitions (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES auth.contact_points (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  from_state varchar(16),
  to_state varchar(16) NOT NULL,
  reason varchar(32) NOT NULL,
  case_id uuid,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  CONSTRAINT contact_transition_edge_valid CHECK (
    (from_state IS NULL AND to_state = 'ACTIVE')
    OR (from_state = 'ACTIVE' AND to_state IN ('REPLACED', 'REVOKED'))
  ),
  CONSTRAINT contact_transition_reason_valid CHECK (
    reason IN ('REGISTRATION', 'RECOVERY', 'CONTACT_CHANGE', 'ACCOUNT_CLOSED')
  ),
  CONSTRAINT contact_transition_case_required CHECK (
    (reason IN ('RECOVERY', 'CONTACT_CHANGE')) = (case_id IS NOT NULL)
  )
);

-- R-09: PLAN §5.2 edges only, immutable identity and envelope, and append-only history.
CREATE FUNCTION auth.enforce_contact_point_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial contact point state', CONSTRAINT = 'contact_point_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.account_id, OLD.channel, OLD.role, OLD.normalization_profile, OLD.key_version,
      OLD.fingerprint, OLD.encryption_algorithm, OLD.encryption_schema_version,
      OLD.kek_key_version, OLD.ciphertext, OLD.nonce, OLD.authentication_tag, OLD.wrapped_dek,
      OLD.created_at)
    IS DISTINCT FROM
     (NEW.id, NEW.account_id, NEW.channel, NEW.role, NEW.normalization_profile, NEW.key_version,
      NEW.fingerprint, NEW.encryption_algorithm, NEW.encryption_schema_version,
      NEW.kek_key_version, NEW.ciphertext, NEW.nonce, NEW.authentication_tag, NEW.wrapped_dek,
      NEW.created_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'immutable contact point fields changed', CONSTRAINT = 'contact_point_immutable_fields';
  END IF;
  IF NOT (OLD.state = 'ACTIVE' AND NEW.state IN ('REPLACED', 'REVOKED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contact point lifecycle transition denied', CONSTRAINT = 'contact_point_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.enforce_contact_fingerprint_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid initial contact fingerprint state', CONSTRAINT = 'contact_fingerprint_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.id, OLD.contact_id, OLD.channel, OLD.normalization_profile, OLD.key_version,
      OLD.fingerprint, OLD.created_at)
    IS DISTINCT FROM
     (NEW.id, NEW.contact_id, NEW.channel, NEW.normalization_profile, NEW.key_version,
      NEW.fingerprint, NEW.created_at)
    OR NOT (OLD.active AND NOT NEW.active)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contact fingerprint lifecycle transition denied', CONSTRAINT = 'contact_fingerprint_lifecycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION auth.reject_contact_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contact transitions are append-only', CONSTRAINT = 'contact_transition_immutable';
END;
$$;

CREATE TRIGGER enforce_contact_point_lifecycle
BEFORE INSERT OR UPDATE ON auth.contact_points
FOR EACH ROW EXECUTE FUNCTION auth.enforce_contact_point_lifecycle();
CREATE TRIGGER enforce_contact_fingerprint_lifecycle
BEFORE INSERT OR UPDATE ON auth.contact_point_fingerprints
FOR EACH ROW EXECUTE FUNCTION auth.enforce_contact_fingerprint_lifecycle();
CREATE TRIGGER reject_contact_transition_mutation
BEFORE UPDATE OR DELETE ON auth.contact_point_transitions
FOR EACH ROW EXECUTE FUNCTION auth.reject_contact_transition_mutation();

-- Inserts a contact point, its fingerprint rows, and its creation transition. Shared by both
-- commands; never granted to a login.
CREATE FUNCTION auth.insert_active_contact(
  p_contact_id uuid,
  p_account_id uuid,
  p_key_versions varchar[],
  p_fingerprints bytea[],
  p_fingerprint_ids uuid[],
  p_kek_key_version varchar,
  p_ciphertext bytea,
  p_nonce bytea,
  p_tag bytea,
  p_wrapped_dek bytea,
  p_transition_id uuid,
  p_reason varchar,
  p_case_id uuid,
  p_occurred_at timestamptz,
  p_correlation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF cardinality(p_key_versions) < 1
    OR cardinality(p_key_versions) <> cardinality(p_fingerprints)
    OR cardinality(p_key_versions) <> cardinality(p_fingerprint_ids)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CONTACT_FINGERPRINT_SET_INVALID';
  END IF;
  INSERT INTO auth.contact_points (
    id, account_id, channel, role, normalization_profile, key_version, fingerprint,
    encryption_algorithm, encryption_schema_version, kek_key_version, ciphertext, nonce,
    authentication_tag, wrapped_dek, state, created_at
  ) VALUES (
    p_contact_id, p_account_id, 'PHONE', 'PRIMARY', 'e164-v1', p_key_versions[1],
    p_fingerprints[1], 'aes-256-gcm', 1, p_kek_key_version, p_ciphertext, p_nonce, p_tag,
    p_wrapped_dek, 'ACTIVE', p_occurred_at
  );
  INSERT INTO auth.contact_point_fingerprints (
    id, contact_id, channel, normalization_profile, key_version, fingerprint, active, created_at
  )
  SELECT p_fingerprint_ids[position], p_contact_id, 'PHONE', 'e164-v1',
         p_key_versions[position], p_fingerprints[position], true, p_occurred_at
  FROM generate_subscripts(p_key_versions, 1) AS position;
  INSERT INTO auth.contact_point_transitions (
    id, contact_id, account_id, from_state, to_state, reason, case_id, occurred_at, correlation_id
  ) VALUES (
    p_transition_id, p_contact_id, p_account_id, NULL, 'ACTIVE', p_reason, p_case_id,
    p_occurred_at, p_correlation_id
  );
END;
$$;

CREATE FUNCTION auth.bind_primary_contact(
  p_contact_id uuid,
  p_account_id uuid,
  p_key_versions varchar[],
  p_fingerprints bytea[],
  p_fingerprint_ids uuid[],
  p_kek_key_version varchar,
  p_ciphertext bytea,
  p_nonce bytea,
  p_tag bytea,
  p_wrapped_dek bytea,
  p_transition_id uuid,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_correlation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_status varchar;
  violated text;
BEGIN
  SELECT account.status INTO account_status
  FROM accounts.accounts account
  WHERE account.id = p_account_id
  FOR SHARE;
  IF NOT FOUND OR account_status = 'CLOSED' THEN
    RETURN 'STALE_CONTACT';
  END IF;

  BEGIN
    PERFORM auth.insert_active_contact(
      p_contact_id, p_account_id, p_key_versions, p_fingerprints, p_fingerprint_ids,
      p_kek_key_version, p_ciphertext, p_nonce, p_tag, p_wrapped_dek, p_transition_id,
      'REGISTRATION', NULL, p_occurred_at, p_correlation_id
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated = 'contact_fingerprint_active_unique' THEN
      RETURN 'CONTACT_ALREADY_BOUND';
    ELSIF violated = 'contact_point_active_primary_unique' THEN
      RETURN 'STALE_CONTACT';
    END IF;
    RAISE;
  END;

  INSERT INTO platform.outbox_events (
    id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at, correlation_id,
    payload
  ) VALUES (
    p_event_id, 'auth.contact.bound', 1, 'auth_contact', p_contact_id, p_occurred_at,
    p_correlation_id,
    jsonb_build_object(
      'contactId', p_contact_id::text,
      'accountId', p_account_id::text,
      'reason', 'REGISTRATION'
    )
  );
  RETURN 'BOUND';
END;
$$;

CREATE FUNCTION auth.replace_primary_contact(
  p_contact_id uuid,
  p_account_id uuid,
  p_expected_contact_id uuid,
  p_key_versions varchar[],
  p_fingerprints bytea[],
  p_fingerprint_ids uuid[],
  p_kek_key_version varchar,
  p_ciphertext bytea,
  p_nonce bytea,
  p_tag bytea,
  p_wrapped_dek bytea,
  p_reason varchar,
  p_case_id uuid,
  p_previous_transition_id uuid,
  p_transition_id uuid,
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_correlation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous_state varchar;
  previous_account uuid;
  account_status varchar;
  violated text;
BEGIN
  IF p_reason NOT IN ('RECOVERY', 'CONTACT_CHANGE') OR p_case_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CONTACT_REPLACEMENT_INVALID';
  END IF;

  SELECT account.status INTO account_status
  FROM accounts.accounts account
  WHERE account.id = p_account_id
  FOR SHARE;
  SELECT contact.state, contact.account_id INTO previous_state, previous_account
  FROM auth.contact_points contact
  WHERE contact.id = p_expected_contact_id
  FOR UPDATE;
  IF account_status IS NULL OR account_status = 'CLOSED' OR previous_state IS DISTINCT FROM 'ACTIVE'
    OR previous_account IS DISTINCT FROM p_account_id
  THEN
    RETURN 'STALE_CONTACT';
  END IF;

  BEGIN
    UPDATE auth.contact_points
    SET state = 'REPLACED', replaced_at = p_occurred_at
    WHERE id = p_expected_contact_id;
    UPDATE auth.contact_point_fingerprints
    SET active = false, deactivated_at = p_occurred_at
    WHERE contact_id = p_expected_contact_id AND active;
    INSERT INTO auth.contact_point_transitions (
      id, contact_id, account_id, from_state, to_state, reason, case_id, occurred_at,
      correlation_id
    ) VALUES (
      p_previous_transition_id, p_expected_contact_id, p_account_id, 'ACTIVE', 'REPLACED',
      p_reason, p_case_id, p_occurred_at, p_correlation_id
    );
    PERFORM auth.insert_active_contact(
      p_contact_id, p_account_id, p_key_versions, p_fingerprints, p_fingerprint_ids,
      p_kek_key_version, p_ciphertext, p_nonce, p_tag, p_wrapped_dek, p_transition_id,
      p_reason, p_case_id, p_occurred_at, p_correlation_id
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated = 'contact_fingerprint_active_unique' THEN
      RETURN 'CONTACT_ALREADY_BOUND';
    END IF;
    RAISE;
  END;

  INSERT INTO platform.outbox_events (
    id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at, correlation_id,
    payload
  ) VALUES (
    p_event_id, 'auth.contact.replaced', 1, 'auth_contact', p_contact_id, p_occurred_at,
    p_correlation_id,
    jsonb_build_object(
      'contactId', p_contact_id::text,
      'previousContactId', p_expected_contact_id::text,
      'accountId', p_account_id::text,
      'reason', p_reason,
      'caseId', p_case_id::text
    )
  );
  RETURN 'BOUND';
END;
$$;

-- Reads one account's active primary envelope; the runtime has no bulk read of envelope columns.
CREATE FUNCTION auth.active_primary_contact_envelope(p_account_id uuid)
RETURNS TABLE (
  contact_id uuid,
  kek_key_version varchar,
  ciphertext bytea,
  nonce bytea,
  authentication_tag bytea,
  wrapped_dek bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT contact.id, contact.kek_key_version, contact.ciphertext, contact.nonce,
         contact.authentication_tag, contact.wrapped_dek
  FROM auth.contact_points contact
  WHERE contact.account_id = p_account_id AND contact.state = 'ACTIVE' AND contact.role = 'PRIMARY';
$$;

-- Command owner privileges.
GRANT USAGE ON SCHEMA auth TO trayvi_lifecycle_owner;
GRANT SELECT, INSERT ON TABLE auth.contact_points TO trayvi_lifecycle_owner;
GRANT UPDATE (state, replaced_at) ON TABLE auth.contact_points TO trayvi_lifecycle_owner;
GRANT SELECT, INSERT ON TABLE auth.contact_point_fingerprints TO trayvi_lifecycle_owner;
GRANT UPDATE (active, deactivated_at) ON TABLE auth.contact_point_fingerprints
  TO trayvi_lifecycle_owner;
GRANT INSERT ON TABLE auth.contact_point_transitions TO trayvi_lifecycle_owner;

-- Ownership and execute rights. Trigger functions keep the default owner; commands move to the
-- non-login command owner.
REVOKE ALL ON FUNCTION auth.enforce_contact_point_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.enforce_contact_fingerprint_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.reject_contact_transition_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.insert_active_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, varchar, uuid,
  timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.bind_primary_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, uuid,
  timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.replace_primary_contact(
  uuid, uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, varchar, uuid,
  uuid, uuid, uuid, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.active_primary_contact_envelope(uuid) FROM PUBLIC;
ALTER FUNCTION auth.insert_active_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, varchar, uuid,
  timestamptz, uuid
) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.bind_primary_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, uuid,
  timestamptz, uuid
) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.replace_primary_contact(
  uuid, uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, varchar, uuid,
  uuid, uuid, uuid, timestamptz, uuid
) OWNER TO trayvi_lifecycle_owner;
ALTER FUNCTION auth.active_primary_contact_envelope(uuid) OWNER TO trayvi_lifecycle_owner;

-- Runtime: non-envelope reads for lookup, the commands, and the single-account envelope read.
REVOKE ALL ON TABLE auth.contact_points, auth.contact_point_fingerprints,
  auth.contact_point_transitions FROM PUBLIC;
GRANT SELECT (id, account_id, channel, role, normalization_profile, state, created_at,
  replaced_at, revoked_at) ON TABLE auth.contact_points TO trayvi_runtime;
GRANT SELECT (id, contact_id, channel, normalization_profile, key_version, fingerprint, active)
  ON TABLE auth.contact_point_fingerprints TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.bind_primary_contact(
  uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, uuid, uuid,
  timestamptz, uuid
) TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.replace_primary_contact(
  uuid, uuid, uuid, varchar[], bytea[], uuid[], varchar, bytea, bytea, bytea, bytea, varchar, uuid,
  uuid, uuid, uuid, timestamptz, uuid
) TO trayvi_runtime;
GRANT EXECUTE ON FUNCTION auth.active_primary_contact_envelope(uuid) TO trayvi_runtime;
