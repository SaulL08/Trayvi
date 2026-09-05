# Phase 0 Foundation Architecture

The repository is a pnpm/Turborepo modular-monolith foundation with two runtime shells and three
foundation packages:

```text
apps/api ------> packages/config
       `-------> packages/observability
apps/worker ---> packages/config
       `-------> packages/observability
tests only ----> packages/test-support
```

The API exposes only liveness/readiness. The worker performs lifecycle initialization only. Neither
contains a domain module or fake product behavior. PostgreSQL owns migration metadata and the minimal
technical outbox; API/worker startup never runs migrations.

Machine checks enforce the authorized workspace shape, foundation-to-application direction, the
single environment boundary, test-support isolation, and separation of provisional brand assets.
The invalid fixture in `packages/test-support/fixtures/invalid-boundary` proves enforcement is active.

Runtime lifecycle is `CREATED -> INITIALIZING -> READY -> DRAINING -> STOPPED`, with `FAILED` possible.
Readiness depends on a timeout-bounded PostgreSQL/PostGIS probe; liveness does not. Request and
correlation UUIDs are normalized at ingress and propagated through async context and trace context.

ADRs 001–010 in [the register](../adr/README.md) are the decision authority for Phase 0.
