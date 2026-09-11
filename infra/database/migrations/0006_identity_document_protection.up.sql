-- Purpose: store encrypted identity documents and versioned HMAC equality aliases without plaintext.
-- Lock/rewrite risk: creates new Phase 1 tables/indexes only; no existing rows are rewritten.
-- Rollback: paired down migration refuses to remove any protected-document or claim row.
CREATE TABLE identity.identity_documents (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES identity.person_identities (id) ON DELETE RESTRICT,
  country_code char(2) NOT NULL,
  issuer_code varchar(32) NOT NULL,
  document_type varchar(32) NOT NULL,
  normalization_profile varchar(64) NOT NULL,
  encryption_algorithm varchar(32) NOT NULL,
  encryption_schema_version smallint NOT NULL,
  kek_key_version varchar(64) NOT NULL,
  ciphertext bytea,
  nonce bytea,
  authentication_tag bytea,
  wrapped_dek bytea,
  state varchar(24) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  superseded_at timestamptz,
  cryptoshredded_at timestamptz,
  CONSTRAINT identity_document_scope_format CHECK (
    country_code ~ '^[A-Z]{2}$'
    AND issuer_code ~ '^[A-Z][A-Z0-9_]{0,31}$'
    AND document_type ~ '^[A-Z][A-Z0-9_]{0,31}$'
    AND normalization_profile ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT identity_document_algorithm_valid CHECK (
    encryption_algorithm = 'aes-256-gcm' AND encryption_schema_version = 1
  ),
  CONSTRAINT identity_document_key_version_format CHECK (
    kek_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT identity_document_state_valid CHECK (
    state IN ('CURRENT', 'SUPERSEDED', 'REVOKED', 'CRYPTOSHREDDED')
  ),
  CONSTRAINT identity_document_envelope_shape CHECK (
    (
      state <> 'CRYPTOSHREDDED'
      AND ciphertext IS NOT NULL
      AND octet_length(ciphertext) > 0
      AND nonce IS NOT NULL
      AND octet_length(nonce) = 12
      AND authentication_tag IS NOT NULL
      AND octet_length(authentication_tag) = 16
      AND wrapped_dek IS NOT NULL
      AND octet_length(wrapped_dek) > 0
      AND cryptoshredded_at IS NULL
    )
    OR (
      state = 'CRYPTOSHREDDED'
      AND ciphertext IS NULL
      AND nonce IS NULL
      AND authentication_tag IS NULL
      AND wrapped_dek IS NULL
      AND cryptoshredded_at IS NOT NULL
    )
  ),
  CONSTRAINT identity_document_timestamp_order CHECK (
    updated_at >= created_at
    AND (superseded_at IS NULL OR superseded_at >= created_at)
    AND (cryptoshredded_at IS NULL OR cryptoshredded_at >= created_at)
  )
);

CREATE UNIQUE INDEX identity_document_current_scope_unique
  ON identity.identity_documents (
    identity_id,
    country_code,
    issuer_code,
    document_type
  )
  WHERE state = 'CURRENT';

CREATE TABLE identity.document_fingerprint_claims (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES identity.identity_documents (id) ON DELETE RESTRICT,
  country_code char(2) NOT NULL,
  issuer_code varchar(32) NOT NULL,
  document_type varchar(32) NOT NULL,
  normalization_profile varchar(64) NOT NULL,
  hmac_algorithm varchar(32) NOT NULL,
  hmac_key_version varchar(64) NOT NULL,
  fingerprint bytea NOT NULL,
  state varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  bound_at timestamptz,
  tombstoned_at timestamptz,
  abandoned_at timestamptz,
  CONSTRAINT document_fingerprint_scope_format CHECK (
    country_code ~ '^[A-Z]{2}$'
    AND issuer_code ~ '^[A-Z][A-Z0-9_]{0,31}$'
    AND document_type ~ '^[A-Z][A-Z0-9_]{0,31}$'
    AND normalization_profile ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT document_fingerprint_algorithm_valid CHECK (
    hmac_algorithm = 'hmac-sha-256' AND octet_length(fingerprint) = 32
  ),
  CONSTRAINT document_fingerprint_key_version_format CHECK (
    hmac_key_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT document_fingerprint_state_valid CHECK (
    state IN ('RESERVED', 'BOUND', 'TOMBSTONED', 'ABANDONED')
  ),
  CONSTRAINT document_fingerprint_state_timestamps CHECK (
    (state = 'RESERVED' AND bound_at IS NULL AND tombstoned_at IS NULL AND abandoned_at IS NULL)
    OR (state = 'BOUND' AND bound_at IS NOT NULL AND tombstoned_at IS NULL AND abandoned_at IS NULL)
    OR (state = 'TOMBSTONED' AND tombstoned_at IS NOT NULL AND abandoned_at IS NULL)
    OR (state = 'ABANDONED' AND abandoned_at IS NOT NULL AND tombstoned_at IS NULL)
  ),
  CONSTRAINT document_fingerprint_document_key_unique UNIQUE (document_id, hmac_key_version)
);

CREATE UNIQUE INDEX document_fingerprint_blocking_unique
  ON identity.document_fingerprint_claims (
    country_code,
    issuer_code,
    document_type,
    normalization_profile,
    hmac_key_version,
    fingerprint
  )
  WHERE state IN ('RESERVED', 'BOUND', 'TOMBSTONED');

REVOKE ALL ON TABLE identity.identity_documents, identity.document_fingerprint_claims FROM PUBLIC;

GRANT INSERT ON TABLE identity.identity_documents TO trayvi_runtime;
GRANT SELECT (
  id,
  identity_id,
  country_code,
  issuer_code,
  document_type,
  normalization_profile,
  encryption_algorithm,
  encryption_schema_version,
  kek_key_version,
  state,
  created_at,
  updated_at,
  superseded_at,
  cryptoshredded_at
) ON TABLE identity.identity_documents TO trayvi_runtime;

GRANT INSERT ON TABLE identity.document_fingerprint_claims TO trayvi_runtime;
GRANT SELECT (
  id,
  document_id,
  country_code,
  issuer_code,
  document_type,
  normalization_profile,
  hmac_algorithm,
  hmac_key_version,
  state,
  created_at,
  bound_at,
  tombstoned_at,
  abandoned_at
) ON TABLE identity.document_fingerprint_claims TO trayvi_runtime;
GRANT UPDATE (state, bound_at, tombstoned_at, abandoned_at)
  ON TABLE identity.document_fingerprint_claims TO trayvi_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE identity.identity_documents, identity.document_fingerprint_claims
  FROM trayvi_runtime;
