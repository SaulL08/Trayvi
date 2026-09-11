-- Purpose: establish the Phase 1 Account/Person Identity aggregate roots and immutable transition evidence.
-- Lock/rewrite risk: creates new schemas/tables only; no existing data is rewritten.
-- Rollback: paired down migration refuses to remove populated Phase 1 domain tables.
CREATE SCHEMA accounts;
CREATE SCHEMA identity;

CREATE TABLE accounts.accounts (
  id uuid PRIMARY KEY,
  status varchar(32) NOT NULL,
  status_reason_code varchar(100) NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  CONSTRAINT account_status_valid CHECK (
    status IN ('PENDING_IDENTITY', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED')
  ),
  CONSTRAINT account_reason_format CHECK (
    status_reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
  ),
  CONSTRAINT account_version_nonnegative CHECK (version >= 0),
  CONSTRAINT account_timestamp_order CHECK (updated_at >= created_at),
  CONSTRAINT account_closed_timestamp CHECK (
    (status = 'CLOSED' AND closed_at IS NOT NULL)
    OR (status <> 'CLOSED' AND closed_at IS NULL)
  )
);

CREATE TABLE accounts.account_creation_operations (
  id uuid PRIMARY KEY,
  caller_binding_commitment bytea NOT NULL,
  idempotency_key_commitment bytea NOT NULL,
  request_commitment bytea NOT NULL,
  request_commitment_key_version varchar(64) NOT NULL,
  submission_commitment bytea,
  submission_commitment_key_version varchar(64),
  state varchar(16) NOT NULL,
  safe_result_code varchar(100) NOT NULL,
  safe_internal_code varchar(100),
  account_id uuid UNIQUE REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT account_creation_operation_binding_length CHECK (
    octet_length(caller_binding_commitment) = 32
    AND octet_length(idempotency_key_commitment) = 32
    AND octet_length(request_commitment) = 32
  ),
  CONSTRAINT account_creation_operation_submission_pair CHECK (
    (submission_commitment IS NULL) = (submission_commitment_key_version IS NULL)
    AND (submission_commitment IS NULL OR octet_length(submission_commitment) = 32)
  ),
  CONSTRAINT account_creation_operation_key_version_format CHECK (
    request_commitment_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    AND (
      submission_commitment_key_version IS NULL
      OR submission_commitment_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    )
  ),
  CONSTRAINT account_creation_operation_state_valid CHECK (
    state IN ('STARTED', 'COMPLETED', 'CONFLICT', 'EXPIRED')
  ),
  CONSTRAINT account_creation_operation_public_code_valid CHECK (
    safe_result_code IN ('ACCOUNT_CREATION_ACCEPTED', 'IDENTITY_SUBMISSION_ACCEPTED')
  ),
  CONSTRAINT account_creation_operation_internal_code_format CHECK (
    safe_internal_code IS NULL OR safe_internal_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
  ),
  CONSTRAINT account_creation_operation_result_shape CHECK (
    (state = 'STARTED' AND account_id IS NULL AND submission_commitment IS NULL)
    OR (
      state = 'COMPLETED'
      AND account_id IS NOT NULL
      AND submission_commitment IS NOT NULL
      AND safe_result_code = 'IDENTITY_SUBMISSION_ACCEPTED'
    )
    OR (
      state IN ('CONFLICT', 'EXPIRED')
      AND account_id IS NULL
      AND submission_commitment IS NOT NULL
      AND safe_result_code = 'IDENTITY_SUBMISSION_ACCEPTED'
    )
  ),
  CONSTRAINT account_creation_operation_timestamp_order CHECK (
    updated_at >= created_at AND expires_at > created_at
  ),
  CONSTRAINT account_creation_operation_idempotency_unique UNIQUE (
    caller_binding_commitment,
    idempotency_key_commitment
  )
);

CREATE INDEX account_creation_operations_expiry_idx
  ON accounts.account_creation_operations (expires_at, id)
  WHERE state = 'STARTED';

CREATE TABLE accounts.account_status_transitions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  from_status varchar(32),
  to_status varchar(32) NOT NULL,
  aggregate_version integer NOT NULL,
  actor_class varchar(64) NOT NULL,
  actor_reference varchar(128) NOT NULL,
  reason_code varchar(100) NOT NULL,
  evidence_reference uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT account_transition_from_status_valid CHECK (
    from_status IS NULL
    OR from_status IN ('PENDING_IDENTITY', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED')
  ),
  CONSTRAINT account_transition_to_status_valid CHECK (
    to_status IN ('PENDING_IDENTITY', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED')
  ),
  CONSTRAINT account_transition_version_nonnegative CHECK (aggregate_version >= 0),
  CONSTRAINT account_transition_actor_format CHECK (
    actor_class ~ '^[A-Z][A-Z0-9_]{0,63}$' AND length(btrim(actor_reference)) > 0
  ),
  CONSTRAINT account_transition_reason_format CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  CONSTRAINT account_transition_version_unique UNIQUE (account_id, aggregate_version)
);

CREATE TABLE identity.person_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts.accounts (id) ON DELETE RESTRICT,
  status varchar(24) NOT NULL,
  status_reason_code varchar(100) NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  established_at timestamptz,
  restricted_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT person_identity_status_valid CHECK (
    status IN ('PENDING', 'ESTABLISHED', 'RESTRICTED', 'RETIRED')
  ),
  CONSTRAINT person_identity_reason_format CHECK (
    status_reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'
  ),
  CONSTRAINT person_identity_version_nonnegative CHECK (version >= 0),
  CONSTRAINT person_identity_timestamp_order CHECK (updated_at >= created_at),
  CONSTRAINT person_identity_state_timestamps CHECK (
    (status = 'PENDING' AND established_at IS NULL AND restricted_at IS NULL AND retired_at IS NULL)
    OR (
      status = 'ESTABLISHED'
      AND established_at IS NOT NULL
      AND restricted_at IS NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'RESTRICTED'
      AND established_at IS NOT NULL
      AND restricted_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (status = 'RETIRED' AND retired_at IS NOT NULL)
  )
);

CREATE TABLE identity.identity_status_transitions (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES identity.person_identities (id) ON DELETE RESTRICT,
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  aggregate_version integer NOT NULL,
  actor_class varchar(64) NOT NULL,
  actor_reference varchar(128) NOT NULL,
  reason_code varchar(100) NOT NULL,
  evidence_reference uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT identity_transition_from_status_valid CHECK (
    from_status IS NULL OR from_status IN ('PENDING', 'ESTABLISHED', 'RESTRICTED', 'RETIRED')
  ),
  CONSTRAINT identity_transition_to_status_valid CHECK (
    to_status IN ('PENDING', 'ESTABLISHED', 'RESTRICTED', 'RETIRED')
  ),
  CONSTRAINT identity_transition_version_nonnegative CHECK (aggregate_version >= 0),
  CONSTRAINT identity_transition_actor_format CHECK (
    actor_class ~ '^[A-Z][A-Z0-9_]{0,63}$' AND length(btrim(actor_reference)) > 0
  ),
  CONSTRAINT identity_transition_reason_format CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  CONSTRAINT identity_transition_version_unique UNIQUE (identity_id, aggregate_version)
);

REVOKE ALL ON SCHEMA accounts, identity FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA accounts, identity FROM PUBLIC;

GRANT USAGE ON SCHEMA accounts, identity TO trayvi_runtime;
GRANT USAGE, CREATE ON SCHEMA accounts, identity TO trayvi_migrator;

GRANT SELECT, INSERT ON TABLE accounts.accounts TO trayvi_runtime;
GRANT UPDATE (status, status_reason_code, version, updated_at, closed_at)
  ON TABLE accounts.accounts TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE accounts.account_creation_operations TO trayvi_runtime;
GRANT UPDATE (
  submission_commitment,
  submission_commitment_key_version,
  state,
  safe_result_code,
  safe_internal_code,
  account_id,
  updated_at
) ON TABLE accounts.account_creation_operations TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE accounts.account_status_transitions TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE identity.person_identities TO trayvi_runtime;
GRANT UPDATE (
  status,
  status_reason_code,
  version,
  updated_at,
  established_at,
  restricted_at,
  retired_at
) ON TABLE identity.person_identities TO trayvi_runtime;
GRANT SELECT, INSERT ON TABLE identity.identity_status_transitions TO trayvi_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA accounts, identity FROM trayvi_runtime;
