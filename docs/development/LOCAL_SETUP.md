# Local Development

## Bootstrap

Use the pinned Node `22.14.0`, then run:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm toolchain:check
corepack pnpm local:env
```

`local:env` creates ignored `.env.local`, `.env.api`, and `.env.worker` files with a cryptographically
random local database password. It refuses to overwrite them unless rotation is explicitly requested
with `scripts/local/initialize-environment.ps1 -Force`. Never commit these files.

## PostgreSQL/PostGIS

```powershell
corepack pnpm local:db:up
corepack pnpm db:migrate:local
corepack pnpm db:verify:local
```

The Compose service is bound to loopback port `54329`, uses a minimal non-root PostgreSQL 17/PostGIS
3.5 image whose upstream Alpine base is pinned by digest, and persists data in a named volume. A
migration URL is used only by migration/test commands;
the application assumes the restricted `trayvi_runtime` role.

## Processes and checks

```powershell
corepack pnpm dev:api
corepack pnpm dev:worker
corepack pnpm verify
corepack pnpm test:integration:local
```

Use Ctrl+C for graceful shutdown. Local JSON logs are emitted to standard output. No real or
production-like personal, location, identity, payment, or credential data may be used.

## Reset

Run `corepack pnpm local:db:down` for a recoverable stop. To intentionally reset all local database
state, review the exact Compose project and then run:

```powershell
docker compose --env-file .env.local -f infra/local/compose.yaml down -v
```

The `-v` operation permanently deletes only the `trayvi-local` Compose volume.
