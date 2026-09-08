# Phase 0 — Additional Audit Remediation

**Status:** READY FOR PHASE 0 SECOND RE-AUDIT  
**Original audit target:** `6b977aa4eb078f4079cb24cbd1370244d31c7e17`  
**First remediation target / first re-audit target:** `01f360aa717593458beae3123db3de925f3fb319`  
**First re-audit record:** `d793ce17776ee811af67434fbee6abbfd0b1bf11`  
**Additional remediation code head:** `8bd1e768d9dd146742e0aa3f0d6c71526d58d9a1`  
**Clean-checkout validation target:** `1d18c00de9807d3c7800ed1dda0056dc7b24561e`  
**Clean-checkout validation tree:** `cba993d35ff10596b54b7c79f0dd794232b8c37d`  
**Hosted corrective target:** `a442d2e6e588de299d1515e3c61ec974fc8971f1`  
**Hosted corrective target tree:** `211a468b317c42aecc1408a5eba075a663f7200d`

This is a chronological addition after the failed first re-audit. It does not revise `AUDIT.md`,
`REMEDIATION.md`, or `RE-AUDIT.md`, and it does not perform the independent second re-audit.

## Findings

### P0-AUD-001 — HIGH — Reopened final logging leak

- **Root cause/new bypass:** Structured context was sanitized, but the raw event string was passed as
  Pino's final `message`; textual redaction also did not normalize percent-encoded separators.
- **Fix:** `482621647a62efbe4d20e04e4f6bbb4bfae37f1d` sanitizes the event once for both
  `event` and final `message`, performs at most two bounded percent-decoding passes, and traverses
  `AggregateError.errors` plus enumerable Error metadata without invoking accessors.
  `a442d2e6e588de299d1515e3c61ec974fc8971f1` additionally classifies database protocol
  `secretKey` fields as sensitive after artifact inspection exposed one ephemeral PostgreSQL value.
- **Files:** `packages/observability/src/logger.ts`, `redaction.ts`, and the redaction unit suite.
- **Regression:** Final serialized Pino output is inspected for plain, colon, quoted, JSON-like,
  query, percent-encoded, case-variant, nested Error, AggregateError, worker/API logger, and exception
  filter paths, including an enumerable PostgreSQL client `secretKey`.
- **Post-fix reproduction:** The exact string-only and `password%3D<canary>` probes emit only
  `[REDACTED]`; the canary is absent from serialized output.
- **Status:** **FIXED — HOSTED VERIFIED**. Independent second re-audit remains pending.

### P0-AUD-004 — MEDIUM — Partially remediated architecture aliases

- **Root cause/new bypass:** Import ownership was inferred from textual specifiers, and environment
  alias discovery depended on source traversal order and literal property names.
- **Fix:** `67d27d62cda4cfaaa0979034fa39a7c1b3e826aa` resolves modules through the
  importer's effective TypeScript configuration and owning workspace. Static string concatenation,
  computed properties, global/process aliases, and forward declarations are resolved to a bounded
  fixed point. `8bd1e768d9dd146742e0aa3f0d6c71526d58d9a1` keeps the compiling fixture under
  the global lint policy.
- **Files:** Architecture gate, its unit suite, a self-contained compiling alias workspace, and root
  TypeScript fixture exclusion.
- **Regression:** The exact `@internal-api/* -> apps/api/*` import and forward
  `globalThis['process']` / `['e' + 'nv']` access compile, then fail the gate. Existing package,
  deep, relative, re-export, dynamic import, and environment fixtures remain active.
- **Post-fix reproduction:** Both re-audit bypasses produce violations; the real repository produces
  none.
- **Status:** **FIXED — HOSTED VERIFIED**. Independent second re-audit remains pending.

### P0-AUD-005 — MEDIUM — Partially remediated migration environment

- **Root cause/new bypass:** `parseMigrationConfig` silently defaulted absent `NODE_ENV` to
  `development`, selecting the weak local TLS policy.
- **Fix:** `3fc3d9a687365acb35b0d9cf171bf1b621581bbb` requires an explicit valid migration
  environment. Local setup selects development and CI selects test explicitly; staging and production
  still require `verify-full`.
- **Files:** Config parser/tests, Phase 0 workflow, and configuration reference.
- **Regression:** Production/staging with `verify-full` pass; disable or missing mode fail; absent and
  invalid environment fail; explicit local development with disabled TLS passes.
- **Post-fix reproduction:** Removing `NODE_ENV` returns `ConfigValidationError` for `NODE_ENV` before
  a migration connection is created.
- **Status:** **FIXED — HOSTED VERIFIED**. Independent second re-audit remains pending.

### P0-AUD-007 — MEDIUM — Partially remediated outbox transitions

- **Root cause/new bypass:** Row constraints validated state shapes but not prior-to-next state, so a
  runtime UPDATE could skip `processing`.
- **Fix:** `d1fe816d38c410885dd6aa46f966a95374598bb8` adds paired migration `0003` with
  database trigger enforcement. Inserts start pending; pending/failed claims enter processing while
  incrementing attempts and setting locks; processing may become published or failed while clearing
  locks; published is terminal.
- **Files:** Paired migration, real-database verification, integration expectation, ADR-008, and the
  migration guide.
- **Regression:** Runtime tests allow every documented transition and deny direct terminal insert,
  pending-to-published, pending-to-failed, published-to-pending, and published-to-processing. They
  also verify timestamps, locks, attempts, safe error codes, state shapes, and DELETE denial.
- **Post-fix reproduction:** The exact single UPDATE from pending to published fails with SQLSTATE
  `23514`; the real database matrix reports `outboxStateTransitions=true`.
- **Status:** **FIXED — HOSTED VERIFIED**. Independent second re-audit remains pending.

### P0-REAUD-001 — LOW — Security subprocess deadlines

- **Root cause/new bypass:** Git and dependency audit children had no internal deadline; dependency
  output was parsed without exit-code validation and partial output could remain pending indefinitely.
- **Fix:** `83700a0d35aa57ea98c9fac964ffe1d70288219c` adds one bounded subprocess executor
  with deadlines, output limits for accumulated reports, explicit allowed exit codes, graceful then
  forced termination, close waiting, and unconditional partial-output rejection.
- **Files:** Bounded process utility/tests, dependency audit, history/repository secret scan, audit
  policy test, and testing guide.
- **Regression:** Success, nonzero exit, hang, partial output plus hang, deadline, child ignoring
  graceful termination on POSIX, registry error JSON, large streamed history, Git failure, and
  history-only secrets are covered.
- **Post-fix reproduction:** A real unavailable-registry run returned
  `security.dependencies.failed` and exit code 1; deterministic hangs terminate and never pass.
- **Status:** **FIXED — HOSTED VERIFIED**. Independent second re-audit remains pending.

## Previously closed regression sample

The complete unit, integration, and database runs re-exercised P0-AUD-002, P0-AUD-003, P0-AUD-006,
P0-AUD-008, P0-AUD-009, P0-AUD-010, and P0-AUD-011. Their shutdown truthfulness, migration-prefix
integrity, physical runtime identity, hostile-object sanitizer, concurrent correlation, advisory
triage, and streamed history controls remained passing.

## Local verification

- Root verification: PASS — format, lint, strict typecheck, architecture, repository/history secrets,
  323 licenses, 68 unit tests, and five builds. One POSIX-only signal-escalation test is skipped on
  Windows.
- Local integration: PASS — 17 tests; two existing POSIX process-signal cases skipped on Windows.
- Database verification: PASS — all 12 PostGIS, migration, role, outbox, failure, and concurrency
  invariants true against a fresh disposable PostgreSQL 17/PostGIS 3.5 container.
- Dependency audit: FAILED CLOSED because the host registry/certificate path returned an invalid
  report. TLS verification was not disabled. The dependency graph and lockfile are unchanged from
  the prior zero-advisory hosted result, but this run is not represented as a fresh security PASS.
- Clean-checkout target: PASS at `1d18c00de9807d3c7800ed1dda0056dc7b24561e`, tree
  `cba993d35ff10596b54b7c79f0dd794232b8c37d`, from an isolated checkout with a frozen dependency
  installation. The primary workspace's `node_modules` and build outputs were not reused.
- Clean-checkout Windows verification: PASS — root verification completed with 68 unit tests and
  one POSIX-only skip; integration completed with 17 tests and two POSIX-only skips; database
  verification reported all 12 invariants true.
- Clean-checkout Linux/POSIX verification: PASS in `node:22.14.0-bookworm-slim` — frozen offline
  install from the pnpm content-addressable store, five clean builds, 69/69 unit tests, 19/19
  integration tests, and all 12 database invariants. This run included graceful-to-forced child
  termination and both compiled process-lifecycle signal cases.
- Local dependency severity counts were not asserted because the live audit failed closed on an
  invalid registry/certificate response. TLS verification remained enabled; the hosted current-target
  counts are recorded below.

## Hosted verification

- Initial publication run `34270806808` completed all configured CI jobs successfully for
  `44766753e46efecac45b729483cb1b15445aa61d`. Post-run artifact inspection then found one
  unredacted ephemeral PostgreSQL `secretKey` in integration artifact `10073766304`. This was
  classified as a security regression; the run and discovery remain recorded.
- Corrective commit `a442d2e6e588de299d1515e3c61ec974fc8971f1` added the minimum redaction rule and a final-output
  regression test. Hosted run `34271765472` completed successfully on `ubuntu-24.04`.
- Security job `102214806197`: PASS — Critical 0, High 0, Moderate 0, repository secrets 0,
  filesystem misconfigurations 0, dependency vulnerabilities 0, and hardened PostGIS image
  vulnerabilities 0. TLS validation was not disabled.
- Quality job `102214806336`: PASS — static gate, 70/70 unit tests with zero skips, coverage evidence,
  and five builds.
- Integration job `102214806230`: PASS — 19/19 integration tests with zero skips, API and Worker
  SIGTERM lifecycle cases, and all 12 database invariants.
- Required gate job `102215415238`: PASS.
- Artifact inspection: PASS — all 44 extracted files were inspected; no tokens, private keys,
  credential-bearing URLs, unredacted passwords, `.env` files, private certificate/key files, or
  unredacted database protocol secret keys were found. The expected `secretKey` field was retained as
  `[REDACTED]`.
- Artifacts, all bound to the corrective commit and retained until 2026-09-22 UTC:
  `phase-00-security` (`10074126495`), `phase-00-integration` (`10074133852`), and
  `phase-00-quality` (`10074147733`).

## Local acceptance

| Criterion  | Local status                             | Basis                                                           |
| ---------- | ---------------------------------------- | --------------------------------------------------------------- |
| AC-008     | PASS                                     | Effective TypeScript alias resolves to the forbidden app.       |
| AC-009     | PASS                                     | Statically computable process/environment aliases fail.         |
| AC-011     | PASS                                     | Migration environment is explicit and fail-closed.              |
| AC-012     | PASS                                     | Staging/production migration TLS cannot downgrade.              |
| AC-014     | PASS                                     | Final serialized logger output redacts the full matrix.         |
| AC-026     | PASS                                     | String-only and encoded canaries do not reach Pino output.      |
| AC-030     | PASS                                     | Config, Git, audit, timeout, partial, and network failures run. |
| AC-033     | PASS                                     | Current architecture/config/logging/outbox/testing docs match.  |
| AC-035     | PENDING SECOND RE-AUDIT                  | Remediation cannot self-approve the phase.                      |
| AC-036     | PASS                                     | Audit and re-audit retain their respective failed outcomes.     |
| **AC-031** | **DEFERRED — PRE-PRODUCTION GOVERNANCE** | No governance mutation was attempted.                           |

## Historical integrity and next gate

- `AUDIT.md` remains SHA-256
  `3EF87D28459B5B5F608CBC202253EACF0F2D27F84E6EC6354601AF7A292F22F1`.
- `REMEDIATION.md` and `RE-AUDIT.md` are unchanged after checkpoint `d793ce1`.
- The historical chain remains: audit failed → remediation → re-audit failed → additional
  remediation.
- Hosted CI and artifact inspection are complete for the additional remediation. Phase 1 remains
  unauthorized, and the independent Phase 0 Second Re-Audit remains pending.

## Decision

**READY FOR PHASE 0 SECOND RE-AUDIT**
