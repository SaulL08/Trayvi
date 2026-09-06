ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  GRANT DELETE ON TABLES TO trayvi_runtime;
GRANT DELETE ON TABLE platform.outbox_events TO trayvi_runtime;

ALTER TABLE platform.outbox_events
  DROP CONSTRAINT outbox_state_consistency;
