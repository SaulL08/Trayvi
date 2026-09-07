-- Purpose: enforce the Phase 0 outbox state machine against direct DML transition skipping.
-- Lock/rewrite risk: installs a trigger under a brief table lock; it does not rewrite existing rows.
-- Rollback: paired down migration removes the trigger and function, restoring shape-only enforcement.
CREATE FUNCTION platform.enforce_outbox_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' THEN
      RETURN NEW;
    END IF;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  ELSIF
    OLD.status IN ('pending', 'failed')
    AND NEW.status = 'processing'
    AND NEW.attempts = OLD.attempts + 1
    AND NEW.locked_at IS NOT NULL
    AND NEW.locked_by IS NOT NULL
    AND NEW.published_at IS NULL
    AND NEW.last_error_code IS NULL
  THEN
    RETURN NEW;
  ELSIF
    OLD.status = 'processing'
    AND NEW.status = 'published'
    AND NEW.attempts = OLD.attempts
    AND NEW.locked_at IS NULL
    AND NEW.locked_by IS NULL
    AND NEW.published_at IS NOT NULL
    AND NEW.last_error_code IS NULL
  THEN
    RETURN NEW;
  ELSIF
    OLD.status = 'processing'
    AND NEW.status = 'failed'
    AND NEW.attempts = OLD.attempts
    AND NEW.locked_at IS NULL
    AND NEW.locked_by IS NULL
    AND NEW.published_at IS NULL
    AND NEW.last_error_code IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'outbox state transition violates the Phase 0 state machine',
    CONSTRAINT = 'outbox_state_transition';
END;
$$;

REVOKE ALL ON FUNCTION platform.enforce_outbox_state_transition() FROM PUBLIC;

CREATE TRIGGER enforce_outbox_state_transition
BEFORE INSERT OR UPDATE OF status ON platform.outbox_events
FOR EACH ROW
EXECUTE FUNCTION platform.enforce_outbox_state_transition();
