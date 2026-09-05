# Trayvi

Trayvi is in **Phase 0 — Foundation and Engineering System**. This repository currently contains a
strict TypeScript monorepo, API and worker process shells, PostgreSQL/PostGIS migration infrastructure,
safe observability primitives, policy checks, and tests. It contains no customer, driver, trip,
commerce, payment, or other product workflow.

The implementation is not production- or pilot-ready. Independent Phase 0 audit, remote CI evidence,
hosting, identity, secrets custody, network controls, backups, and operational ownership remain gates.

Repository licensing status: **PROPRIETARY / ALL RIGHTS RESERVED — pending legal finalization.**
See [licensing status](LICENSE.md) and [repository governance](docs/REPOSITORY_GOVERNANCE.md).

## Prerequisites

- Git;
- Node.js `22.14.0` (see `.nvmrc` and `.node-version`);
- Corepack supplied with the pinned Node distribution;
- Docker Desktop or another Docker Compose-compatible runtime.

No global pnpm installation is required.

## Windows quick start

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm toolchain:check
corepack pnpm local:env
corepack pnpm local:db:up
corepack pnpm db:migrate:local
corepack pnpm verify
corepack pnpm test:integration:local
corepack pnpm db:verify:local
```

Start the processes in separate terminals:

```powershell
corepack pnpm dev:api
corepack pnpm dev:worker
```

The API binds to `127.0.0.1:3000` by default. Foundation endpoints are `GET /health/live` and
`GET /health/ready`. Stop local PostgreSQL with `corepack pnpm local:db:down`; add `-- -v` only when
you intentionally want Docker Compose to remove the local database volume.

## Verification

- `corepack pnpm verify`: toolchain, formatting, lint, strict types, boundaries, secret and license
  checks, unit tests, build.
- `corepack pnpm verify:full`: the same plus real-database integration, migration verification, and
  dependency audit; it expects `MIGRATION_DATABASE_URL`/`DATABASE_URL` in the process environment.
- On Windows with generated local files, use `test:integration:local` and `db:verify:local`.

See [local setup](docs/development/LOCAL_SETUP.md),
[configuration](docs/development/CONFIGURATION.md), [migrations](docs/database/MIGRATIONS.md),
[testing](docs/testing/TESTING.md), [security](docs/security/THREAT_MODEL_PHASE_00.md),
[observability](docs/observability/OBSERVABILITY.md), and the
[foundation runbook](docs/operations/FOUNDATION_RUNBOOK.md).

The authoritative scope is the [Phase 0 plan](docs/phases/phase-00-foundation/PLAN.md), and executed
evidence is recorded in [IMPLEMENTATION.md](docs/phases/phase-00-foundation/IMPLEMENTATION.md).
