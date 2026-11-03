-- Purpose: SPEC-001 integration scaffold. Creates the empty `auth` schema that owns Phase 2
-- contact points, verification challenges, rate-limit buckets, and provider callback receipts.
-- Lock/rewrite risk: schema creation and grants only.
-- Rollback: paired down migration refuses to drop the schema while it holds any object.
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO trayvi_runtime;
GRANT USAGE, CREATE ON SCHEMA auth TO trayvi_migrator;
