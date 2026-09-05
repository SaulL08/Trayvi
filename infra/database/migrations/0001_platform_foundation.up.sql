-- Purpose: prove PostGIS, explicit SQL migrations, runtime grants, and transactional outbox.
-- Lock/rewrite risk: new technical objects only; no existing-table rewrite.
-- Rollback: paired down migration drops the Phase 0 outbox/schema, retaining the shared extension.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA platform;

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  event_type varchar(160) NOT NULL,
  schema_version smallint NOT NULL,
  aggregate_type varchar(100) NOT NULL,
  aggregate_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  locked_by varchar(128),
  published_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbox_event_type_format CHECK (
    event_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'
  ),
  CONSTRAINT outbox_schema_version_positive CHECK (schema_version > 0),
  CONSTRAINT outbox_aggregate_type_format CHECK (
    aggregate_type ~ '^[a-z][a-z0-9_]{0,99}$'
  ),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_status_valid CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  CONSTRAINT outbox_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT outbox_lock_pair CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT outbox_publication_state CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  )
);

CREATE INDEX outbox_events_claim_idx
  ON platform.outbox_events (available_at, occurred_at, id)
  WHERE status IN ('pending', 'failed');

GRANT USAGE ON SCHEMA platform TO trayvi_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform.outbox_events TO trayvi_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE platform.outbox_events FROM trayvi_runtime;

GRANT USAGE, CREATE ON SCHEMA platform TO trayvi_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trayvi_runtime;

