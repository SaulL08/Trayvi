-- Rollback: remove transition enforcement while retaining the state-shape constraint from 0002.
DROP TRIGGER enforce_outbox_state_transition ON platform.outbox_events;
DROP FUNCTION platform.enforce_outbox_state_transition();
