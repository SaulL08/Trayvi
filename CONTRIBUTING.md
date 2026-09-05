# Contributing to Trayvi

Phase work follows the gate in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md). Do not add a
business capability before its owning phase is planned, implemented, independently audited, and
passed.

## Local checks

Use the pinned Node and pnpm versions. Before requesting review, run:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Database-backed changes must also run `corepack pnpm verify:full` against the documented local
PostgreSQL/PostGIS service.

## Change rules

The default branch is `main`. `.gitattributes` normalizes text to LF; Windows batch files use CRLF.

- Use Conventional Commit style (`type(scope): summary`) once a remote workflow is established.
- Keep domain ownership and dependency direction explicit.
- Add reviewed SQL migrations; do not mutate an already shared migration.
- Never commit credentials, `.env` files, private keys, logs, or production data.
- Describe security, privacy, migration, rollback, observability, and failure behavior in the review.
- Accepted ADRs are superseded by a new ADR, not silently rewritten.

Repository ownership identities and protected-branch rules are intentionally pending until a remote
hosting organization exists.
