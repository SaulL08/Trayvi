-- Local/CI cluster bootstrap. Production creates login principals in its secrets/IAM layer and
-- grants membership to these NOLOGIN roles. The next bootstrap step creates a distinct local
-- runtime login from an injected, generated secret; this SQL file contains no credential.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_migrator') THEN
    CREATE ROLE trayvi_migrator NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trayvi_runtime') THEN
    CREATE ROLE trayvi_runtime NOLOGIN NOINHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA public FROM trayvi_runtime;
GRANT USAGE ON SCHEMA public TO trayvi_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO trayvi_migrator;
