# Testing Guide

Vitest uses separate `unit` and `integration` projects. Unit tests require no external services.
Integration tests use real PostgreSQL/PostGIS and generated disposable databases; SQLite and in-memory
database substitutes are not accepted for persistence invariants.

```powershell
corepack pnpm test:unit
corepack pnpm test:coverage
corepack pnpm local:db:up
corepack pnpm test:integration:local
corepack pnpm db:verify:local
```

The suites protect configuration failure, UUID normalization/context, recursive redaction, safe
errors, health/readiness recovery, request limits/CORS, metrics, telemetry failure, architecture
boundaries, secret detection, worker lifecycle, migration behavior, least-privilege grants, PostGIS,
and outbox atomicity.

Audit regressions additionally cover free-form error secrets, hostile getters/proxies, 25 concurrent
timeout contexts, handler drain/deadline truthfulness, workspace import/environment aliases, exact
migration-prefix and pair integrity, verified database TLS, independent runtime login restrictions,
outbox state/transition/DELETE controls, dependency-advisory triage, and streamed Git history beyond
20 MiB. Git security operations and dependency audit subprocesses have internal deadlines, graceful
then forced termination, validated exit codes, and fail-closed handling for network errors and
partial output. The subprocess suite exercises success, nonzero exit, hangs, partial output with a
hang, deadline expiry, and a child that ignores graceful termination on POSIX.

Compiled API/worker `start -> SIGTERM -> stop` tests run on Linux CI. Windows cannot deliver POSIX
`SIGTERM` to a child Node process with equivalent semantics, so the Windows path verifies the same
close/drain idempotency in-process and skips only that platform-specific child-signal case.

Coverage is diagnostic. A percentage never replaces a named invariant or failure-path test.

`test:coverage` includes integrations and therefore requires the database URLs in the process
environment. For service-free coverage use `corepack pnpm test:unit --coverage`.

AC-027 includes a slow-handler timeout with a fixed safe 503 envelope, a nonresponsive TCP peer
that exercises readiness's real deadline, deterministic shutdown timing, and a real-time stalled
shutdown task with structured timeout output. The TCP peer is only a failure simulation; all
persistence, migration, privilege, and PostGIS assertions still use real PostgreSQL.

Final local results and artifact hashes are recorded in
[the implementation evidence](../phases/phase-00-foundation/evidence/implementation-verification.json).
