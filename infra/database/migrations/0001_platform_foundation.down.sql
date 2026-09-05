-- The PostGIS extension is deliberately retained because it may be platform-managed/shared.
REVOKE ALL ON TABLE platform.outbox_events FROM trayvi_runtime;
REVOKE ALL ON SCHEMA platform FROM trayvi_runtime;
REVOKE ALL ON SCHEMA platform FROM trayvi_migrator;
DROP TABLE platform.outbox_events;
DROP SCHEMA platform;

