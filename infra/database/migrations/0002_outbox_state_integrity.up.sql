-- Purpose: encode the Phase 0 outbox state contract and remove destructive runtime deletion.
-- Lock/rewrite risk: validates the currently empty/foundation-only table and takes an ALTER lock.
-- Rollback: paired down migration removes the state constraint and restores the prior DELETE grant.
ALTER TABLE platform.outbox_events
  ADD CONSTRAINT outbox_state_consistency CHECK (
    (
      status = 'pending'
      AND attempts = 0
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND published_at IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'processing'
      AND attempts > 0
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND published_at IS NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'published'
      AND attempts > 0
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND published_at IS NOT NULL
      AND last_error_code IS NULL
    )
    OR (
      status = 'failed'
      AND attempts > 0
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND published_at IS NULL
      AND last_error_code IS NOT NULL
    )
  );

REVOKE DELETE ON TABLE platform.outbox_events FROM trayvi_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  REVOKE DELETE ON TABLES FROM trayvi_runtime;
