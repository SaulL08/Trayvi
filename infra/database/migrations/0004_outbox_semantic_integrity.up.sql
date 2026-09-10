-- Purpose: make the outbox event envelope immutable and limit runtime updates to valid lifecycle transitions.
-- Lock/rewrite risk: changes privileges and installs a trigger under a brief table lock; no rows are rewritten.
-- Rollback: paired down migration restores the prior table-wide UPDATE grant and removes the trigger.
REVOKE UPDATE ON TABLE platform.outbox_events FROM trayvi_runtime;
GRANT UPDATE (
  status,
  attempts,
  available_at,
  locked_at,
  locked_by,
  published_at,
  last_error_code
) ON TABLE platform.outbox_events TO trayvi_runtime;

CREATE FUNCTION platform.enforce_outbox_semantic_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
    OR OLD.aggregate_type IS DISTINCT FROM NEW.aggregate_type
    OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id
    OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
    OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
    OR OLD.causation_id IS DISTINCT FROM NEW.causation_id
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'outbox event identity and content are immutable after insert',
      CONSTRAINT = 'outbox_event_immutable';
  END IF;

  IF OLD.available_at IS DISTINCT FROM NEW.available_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'outbox scheduling metadata has no mutable Phase 0 transition',
      CONSTRAINT = 'outbox_schedule_transition';
  END IF;

  IF OLD.status = NEW.status AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'outbox processing metadata may change only with a valid state transition',
      CONSTRAINT = 'outbox_metadata_transition';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION platform.enforce_outbox_semantic_integrity() FROM PUBLIC;

CREATE TRIGGER enforce_outbox_semantic_integrity
BEFORE UPDATE ON platform.outbox_events
FOR EACH ROW
EXECUTE FUNCTION platform.enforce_outbox_semantic_integrity();
