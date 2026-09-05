# Database and Migration Guide

Canonical migrations are paired `NNNN_name.up.sql` and `NNNN_name.down.sql` files under
`infra/database/migrations`. The repository runner computes SHA-256 checksums, takes a session
advisory lock, applies each file in a transaction, and records only successful versions in
`public.trayvi_schema_migrations`.

Commands using generated local configuration:

```powershell
corepack pnpm db:migrate:local
node --env-file=.env.api --import tsx scripts/db/migrate.ts status
node --env-file=.env.api --import tsx scripts/db/migrate.ts down
corepack pnpm db:verify:local
```

Never edit an applied migration. Add a new reviewed pair with purpose, lock/rewrite risk, rollout,
rollback/roll-forward, privilege changes, and verification. Runtime startup does not migrate.

The Phase 0 migration enables PostGIS, creates only `platform.outbox_events`, grants runtime DML but
not schema DDL, and supplies a paired local rollback. PostgreSQL extension provisioning may require a
platform administrator in production before the restricted migrator runs.

`db:verify` creates isolated disposable databases and proves clean apply, repeat no-op, rollback and
roll-forward, invalid SQL rollback, concurrent serialization, PostGIS, runtime DDL denial, and outbox
commit/rollback atomicity. Disposable databases are removed in `finally` blocks.
