# Database and Migration Guide

Canonical migrations are paired `NNNN_name.up.sql` and `NNNN_name.down.sql` files under
`infra/database/migrations`. The repository runner requires an exact up/down pair per version,
computes SHA-256 checksums for both files and their pair, takes a session advisory lock, applies each
file in a transaction, and records only successful versions in
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

Before status, up, or down, the runner requires applied versions to be an exact prefix of the local
history and verifies all recorded metadata. Unknown versions, gaps, missing local files, incomplete
metadata, and drift in either direction fail before SQL executes. The only metadata upgrade accepted
is the transactional conversion from the exact legacy single-checksum schema.

The Phase 0 migrations enable PostGIS, create only `platform.outbox_events`, enforce coherent pending,
processing, published, and failed field combinations, grant allowlisted runtime DML without DELETE or
schema DDL, and supply paired local rollback. PostgreSQL extension provisioning may require a platform
administrator in production before the restricted migrator runs.

`db:verify` creates isolated disposable databases and proves clean apply, repeat no-op, rollback and
roll-forward, invalid SQL rollback, concurrent serialization, PostGIS, restricted session identity,
role-escalation/DDL denial, outbox state integrity, DELETE denial, and commit/rollback atomicity.
Disposable databases are removed in `finally` blocks.
