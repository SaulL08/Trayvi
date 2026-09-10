-- Rollback: restore the pre-0004 UPDATE privilege and remove semantic-integrity enforcement.
DROP TRIGGER enforce_outbox_semantic_integrity ON platform.outbox_events;
DROP FUNCTION platform.enforce_outbox_semantic_integrity();

REVOKE UPDATE (
  status,
  attempts,
  available_at,
  locked_at,
  locked_by,
  published_at,
  last_error_code
) ON TABLE platform.outbox_events FROM trayvi_runtime;
GRANT UPDATE ON TABLE platform.outbox_events TO trayvi_runtime;
