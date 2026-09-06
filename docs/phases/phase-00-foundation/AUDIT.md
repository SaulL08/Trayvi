# Phase 0 — Adversarial Audit

**Decision:** PHASE 0 AUDIT FAILED — REMEDIATION REQUIRED  
**Audit date:** 2026-09-05 America/Santo_Domingo / 2026-09-06 UTC  
**Target commit:** `6b977aa4eb078f4079cb24cbd1370244d31c7e17`  
**Target tree:** `d84af81824c45e7148798576c166f6acd893f76b`  
**Branch:** `main`  
**Repository:** private `SaulL08/Trayvi`

## Scope and independence

This is the first adversarial audit of Phase 0. It treats implementation evidence as a claim to
falsify, not as audit evidence by itself. It covers repository reproducibility, configuration,
secrets, API security, health, process lifecycle, worker behavior, PostgreSQL/PostGIS, migrations,
the technical outbox, concurrency, observability, error handling, bounded resource use, supply
chain, container security, CI, architecture boundaries, and documentation drift. It contains no
Phase 1 implementation or product behavior.

The worktree was clean at entry. Local `HEAD`, `origin/main`, GitHub `main`, and hosted run
`34007817063` all identified the target commit above. Audit reproduction code lived only in ignored
`.tmp` paths. Production source was not changed during discovery. Reproduction databases were given
unique audit names and removed in `finally` paths.

## Methodology

- Read the project overview, architecture vision, roadmap, security and Trust & Safety principles,
  system master plan, Phase 0 plan and implementation record, evidence JSON, ADR-001 through
  ADR-010, repository governance, development, database, testing, observability and operations docs.
- Inspected all tracked Phase 0 application, package, migration, bootstrap, security, architecture,
  CI and test sources.
- Ran the existing root gate, Windows integration suite, and eight-invariant database verification.
- Reproduced findings with temporary TypeScript harnesses, real loopback HTTP, and isolated real
  PostgreSQL databases. Used static analysis only where executing the failure would require corrupting
  history or creating unsafe material.
- Inspected the effective container user, capabilities, writable paths, limits, loopback binding,
  image metadata and health.
- Rechecked exact-SHA hosted CI and downloaded its security artifact. Local registry calls were not
  trusted after certificate-chain validation failed; TLS validation was not disabled.
- Attempted a separate local clone and frozen install. The clone succeeded, but the offline store was
  incomplete and the host's intercepted certificate chain prevented safe online completion. The
  exact target SHA still passed all four jobs on GitHub's `ubuntu-24.04` runner.

## Environments and tools

- Windows/PowerShell workspace with Node.js `22.14.0`, pnpm `11.25.0`, TypeScript `6.0.3`, Vitest
  `4.1.1`, Git, ripgrep, and direct source inspection.
- Docker Desktop Engine `29.7.2`, Linux engine, and the local hardened PostgreSQL 17/PostGIS 3.5
  image.
- Real PostgreSQL/PostGIS over loopback; every audit database was disposable.
- GitHub Actions run `34007817063` on `ubuntu-24.04` and GitHub REST API read-back.

## Severity summary

| Severity | Open |
| -------- | ---: |
| CRITICAL |    0 |
| HIGH     |    3 |
| MEDIUM   |    7 |
| LOW      |    1 |
| INFO     |    0 |

Any open HIGH finding fails Phase 0. Medium findings below also invalidate named acceptance claims
and require an explicit remediation decision. No severity was reduced to obtain a pass.

## Findings

| ID         | Severity | Area                       | Title                                                               | Blocking |
| ---------- | -------- | -------------------------- | ------------------------------------------------------------------- | -------- |
| P0-AUD-001 | HIGH     | Secret handling / errors   | Error-message credentials bypass final log redaction                | Yes      |
| P0-AUD-002 | HIGH     | Shutdown / resource bounds | Timed-out handlers survive close after `api.stopped`                | Yes      |
| P0-AUD-003 | HIGH     | Migration integrity        | Migrator accepts unknown applied state and unauthenticated down SQL | Yes      |
| P0-AUD-004 | MEDIUM   | Architecture boundaries    | Boundary gate is bypassed by ordinary aliases and package imports   | Yes      |
| P0-AUD-005 | MEDIUM   | Configuration / transport  | Production config accepts a plaintext PostgreSQL connection         | Yes      |
| P0-AUD-006 | MEDIUM   | Database privileges        | Runtime DDL test uses an escapable administrator session            | Yes      |
| P0-AUD-007 | MEDIUM   | Transactional outbox       | Contradictory states and destructive runtime privilege are allowed  | Yes      |
| P0-AUD-008 | MEDIUM   | Logging availability       | Sanitizer executes getters and propagates their exceptions          | Yes      |
| P0-AUD-009 | MEDIUM   | Observability              | Timeout failures lose request and correlation identifiers           | Yes      |
| P0-AUD-010 | MEDIUM   | Supply chain               | One Moderate advisory is retained without identity or assessment    | Yes      |
| P0-AUD-011 | LOW      | Secret scanning            | History scan errors are silently treated as an empty result         | No       |

### P0-AUD-001 — Error-message credentials bypass final log redaction

- **Severity:** HIGH
- **Area:** Secret handling, observability, error handling
- **Affected files:** `packages/observability/src/redaction.ts`,
  `packages/observability/src/logger.ts`, `apps/api/src/http/safe-exception.filter.ts`
- **Description:** Sensitive object keys are redacted, and several string forms are recognized, but
  a conventional secret embedded in an error string such as `password=<value>` is left intact.
  `StructuredLogger.error` serializes the sanitized `Error`, so the value reaches the final log
  boundary. The global API exception filter logs unexpected errors through this path.
- **Reproduction:** Sanitizing `new Error("password=<audit-canary>")` retained the canary. A final
  `StructuredLogger.error` record retained it too. An end-to-end test-only API route returned a safe
  500 envelope while the corresponding log contained the canary.
- **Evidence:** `evidence/audit/adversarial-probes.json`:
  `errorMessageSecretLeakedBySanitizer`, `errorMessageSecretLeakedByFinalLogger`, and
  `unexpectedErrorLogContainedCanary` are true; `unexpectedErrorResponseContainedCanary` is false.
- **Impact:** A provider, database, configuration, or application exception that embeds a credential
  in key/value text can copy that credential into general logs. This violates the central redaction
  guarantee and can expose secrets to log readers and exporters.
- **Root cause:** String sanitization covers Bearer/JWT-like values, PostgreSQL URLs, and URL query
  values but not sensitive key/value forms in free-form error messages or stacks. Existing tests put
  most canaries under sensitive object keys and therefore do not exercise this path.
- **Recommended remediation:** Define bounded patterns for documented sensitive keys in free-form
  strings, sanitize message and stack consistently, add end-to-end exception-filter tests for each
  form, and verify no raw canary reaches JSON, pretty logs, or telemetry.
- **Blocking status:** Blocks AC-014 and AC-026 and therefore Phase 0.

### P0-AUD-002 — Timed-out handlers survive close after `api.stopped`

- **Severity:** HIGH
- **Area:** Graceful shutdown, request timeout, resource exhaustion
- **Affected files:** `apps/api/src/bootstrap.ts`, `apps/api/src/main.ts`,
  `apps/api/test/api-foundation.integration.test.ts`
- **Description:** Fastify's handler timeout sends a 503 but does not cancel the application handler.
  `ApiApplication.close()` resolves and logs `api.stopped` without waiting for those timed-out
  operations. The existing slow-handler test checks only response latency and then calls close; it
  never asserts that the handler stopped or drained.
- **Reproduction:** Over real loopback HTTP, 25 concurrent handlers each waited 500 ms with a 100 ms
  handler timeout. All 25 clients received 503. At that point all 25 handlers remained active. After
  `runtime.close()` resolved and `api.stopped` was logged, all 25 were still active and none had
  completed. They completed about 550 ms later.
- **Evidence:** `evidence/audit/adversarial-probes.json` records the 25/25 counts before close, after
  close, and after the additional wait.
- **Impact:** Slow or malicious requests can continue consuming resources after clients time out and
  after shutdown declares success. Future database or external-side-effect handlers could continue
  or be terminated after the process advertises a clean stop, risking duplicate work, partial work,
  and loss of integrity during deployment.
- **Root cause:** The timeout controls the reply, not handler cancellation. The shutdown path has no
  in-flight operation registry, abort propagation, or drain assertion. The generic
  `ShutdownCoordinator` is not used by either process.
- **Recommended remediation:** Add an abort signal to request work, require handlers/adapters to honor
  it, track in-flight operations, stop admission before close, drain to the configured deadline, and
  return a failed shutdown outcome if work remains. Retest over real HTTP with active side effects,
  repeated signals, startup shutdown, slow dependencies, and deadline expiry.
- **Blocking status:** Blocks AC-022, AC-027, and AC-030 and therefore Phase 0.

### P0-AUD-003 — Migrator accepts unknown applied state and unauthenticated down SQL

- **Severity:** HIGH
- **Area:** Migration integrity and reproducibility
- **Affected files:** `scripts/db/migrate.ts`
- **Description:** `up()` checks repository definitions only against matching applied versions. It
  never rejects an applied database version absent from the repository. Migration checksums cover
  only `upSql`; `down()` checks that checksum and then executes the current, unchecked `downSql`.
- **Reproduction:** In one disposable database, audit code applied `0001`, inserted a syntactically
  valid applied row `9999` absent from the repository, and reran `up()`. The call succeeded with
  `applied: []` and `skipped: ["0001"]`. In another disposable database, audit code applied a test
  migration, changed only its down SQL, and called `down()`. The changed rollback was accepted and
  created an audit marker table, proving execution of SQL that was not authenticated at apply time.
- **Evidence:** `evidence/audit/adversarial-probes.json` under `database.migrations`.
- **Impact:** A deployment can report successful migration against a database whose schema history is
  ahead of, divergent from, or partially unrelated to the checked-out code. An edited rollback can
  perform unintended destructive actions without checksum detection. Both break reproducibility and
  database integrity assumptions.
- **Root cause:** Applied-state validation is one-directional, and the metadata row stores no checksum
  for the rollback artifact or immutable migration-pair manifest.
- **Recommended remediation:** Require the applied list to be an exact ordered prefix of repository
  migrations; reject unknown, missing-middle, reordered, name-mismatched, or checksum-mismatched
  state. Authenticate both up and down artifacts, or record an immutable pair/manifest checksum at
  apply time. Add corruption and down-drift tests before any remediation is accepted.
- **Blocking status:** Blocks AC-019 and therefore Phase 0.

### P0-AUD-004 — Boundary gate is bypassed by ordinary aliases and package imports

- **Severity:** MEDIUM
- **Area:** Architecture boundaries
- **Affected files:** `scripts/architecture/check-boundaries.ts`,
  `scripts/architecture/check-boundaries.unit.test.ts`
- **Description:** Environment detection recognizes only direct `process.env` forms. Dependency
  detection infers app imports from relative paths containing `apps/` and does not identify a package
  import such as `@trayvi/api`. Package manifests are not evaluated.
- **Reproduction:** A temporary file at `packages/config/src/bypass.ts` imported `@trayvi/api`, aliased
  `globalThis.process`, and read `processAlias.env`. `inspectArchitectureFiles` returned zero
  violations.
- **Evidence:** `evidence/audit/adversarial-probes.json` under `architecture`.
- **Impact:** A routine refactor can violate both the app-to-foundation direction and the single
  environment boundary while CI remains green.
- **Root cause:** The gate matches a small set of AST shapes and path substrings instead of resolving
  module ownership and symbol aliases; the regression fixture covers only one relative import.
- **Recommended remediation:** Resolve imports against workspace manifests/TypeScript configuration,
  enforce package graph direction from `package.json`, and use symbol-aware analysis or an ESLint rule
  for environment access. Add adversarial fixtures for aliases, `globalThis`, element access, dynamic
  imports, package names, exports, JavaScript, and manifest-only dependencies.
- **Blocking status:** Invalidates AC-008; remediation is required for Phase 0 pass.

### P0-AUD-005 — Production config accepts a plaintext PostgreSQL connection

- **Severity:** MEDIUM
- **Area:** Configuration and transport security
- **Affected files:** `packages/config/src/parse-config.ts`,
  `docs/development/CONFIGURATION.md`
- **Description:** Production validation requires HTTPS for CORS origins and the OTLP exporter, but a
  production `DATABASE_URL` without TLS parameters is accepted. `parseMigrationConfig` has no
  production-aware transport or credential checks.
- **Reproduction:** A complete `NODE_ENV=production` config with explicit bind host, HTTPS origin,
  non-placeholder credentials, and `postgresql://...` without TLS parsed successfully.
- **Evidence:** `evidence/audit/adversarial-probes.json`:
  `productionDatabaseWithoutTlsAccepted` is true.
- **Impact:** A configuration represented as production-safe can send database credentials and data
  without transport encryption, contrary to `SECURITY_PRINCIPLES.md`. The repository documents TLS
  topology as a production blocker but does not make this unsafe state fail closed.
- **Root cause:** URL validation checks scheme and credential heuristics, but not effective PostgreSQL
  TLS mode or a separately typed SSL policy.
- **Recommended remediation:** Add a typed database TLS policy, require verified TLS in staging and
  production for runtime and migration connections, reject disabling query parameters, and test the
  actual `pg` connection options rather than only the URL text.
- **Blocking status:** Invalidates AC-012; remediation is required for Phase 0 pass.

### P0-AUD-006 — Runtime DDL test uses an escapable administrator session

- **Severity:** MEDIUM
- **Area:** PostgreSQL privileges and test validity
- **Affected files:** `scripts/local/initialize-environment.ps1`, `apps/api/src/database-probe.ts`,
  `scripts/db/verification.ts`, `infra/database/bootstrap/0001_roles.sql`
- **Description:** Local API configuration authenticates as `trayvi_local_admin` and sets
  `role=trayvi_runtime` through libpq options. The existing test similarly authenticates as the
  administrator and executes `SET LOCAL ROLE trayvi_runtime`; it proves only the current role's DDL
  denial, not the session principal's privilege boundary.
- **Reproduction:** A runtime-shaped connection reported session user `trayvi_local_admin` and current
  user `trayvi_runtime`; DDL was initially denied. `SET ROLE trayvi_local_admin` restored the
  administrator current user and DDL succeeded in the disposable database. `RESET ROLE` alone stayed
  constrained because the startup option reapplied the role, but it did not prevent the explicit
  role change.
- **Evidence:** `evidence/audit/adversarial-probes.json` under `database.runtimeRole`.
- **Impact:** If application SQL becomes attacker-controlled or the process is compromised in the
  documented local/CI pattern, the supposed runtime boundary is escapable. More importantly, the
  passing test is not evidence that a real production login lacks DDL or role-escalation ability.
- **Root cause:** Convenience role switching is used in place of authenticating as a dedicated
  restricted login, and the test does not inspect session identity, memberships, `SET ROLE`, object
  ownership, or effective privileges through that login.
- **Recommended remediation:** Provision a generated restricted login in the disposable cluster,
  connect the API and tests with its own credential, ensure it is not a member of elevated roles, and
  test DDL, ownership, `SET ROLE`, `RESET ROLE`, function/search-path and grant paths. Keep migrator and
  runtime credentials distinct.
- **Blocking status:** Invalidates AC-020; remediation is required for Phase 0 pass.

### P0-AUD-007 — Contradictory outbox states and destructive runtime privilege are allowed

- **Severity:** MEDIUM
- **Area:** Transactional outbox and database concurrency
- **Affected files:** `infra/database/migrations/0001_platform_foundation.up.sql`
- **Description:** Constraints validate individual values but do not enforce the outbox state model.
  The runtime role also receives `DELETE` on the outbox table.
- **Reproduction:** The database accepted a `processing` row without `locked_at/locked_by` and a
  `pending` row with a lock and error code. Effective privilege inspection returned DELETE true,
  TRIGGER false, and TRUNCATE false for `trayvi_runtime`.
- **Evidence:** `evidence/audit/adversarial-probes.json` under `database.outbox`.
- **Impact:** Future concurrent consumers cannot distinguish valid claims from contradictory rows;
  runtime code can permanently delete undelivered or forensic event records. At-least-once delivery,
  retry ownership, and recovery assumptions are not encoded in the foundation that claims to prepare
  them.
- **Root cause:** The schema models fields and an index before defining state-transition invariants and
  splits no producer, claimer, publisher, or retention privileges.
- **Recommended remediation:** Define allowed field combinations and transitions, claim expiry and
  retry/dead-letter semantics before activating a consumer. Separate producer/worker/maintenance
  roles, remove ordinary DELETE, and add concurrent `SKIP LOCKED`/lease-expiry/idempotency tests.
- **Blocking status:** Remediation is required because the Phase 0 outbox slice is present and ADR-008
  claims atomic, at-least-once-ready foundations.

### P0-AUD-008 — Sanitizer executes getters and propagates their exceptions

- **Severity:** MEDIUM
- **Area:** Logging availability and defensive serialization
- **Affected files:** `packages/observability/src/redaction.ts`
- **Description:** `Object.entries(value)` invokes enumerable getters. Direct reads of Error fields can
  also invoke accessors. An accessor exception escapes the sanitizer and logger.
- **Reproduction:** An object with one enumerable getter incremented a counter and threw. The
  sanitizer invoked it once and propagated the Error.
- **Evidence:** `evidence/audit/adversarial-probes.json`:
  `hostileEnumerableGetterInvoked` and `hostileEnumerableGetterCausedSanitizerThrow` are true.
- **Impact:** Logging an unusual provider object, proxy, or hostile error can replace the original
  failure with a logging failure, prevent the safe exception filter from replying, or destabilize a
  process during an incident.
- **Root cause:** The sanitizer assumes ordinary data properties and does not inspect property
  descriptors or contain reflection/accessor failures.
- **Recommended remediation:** Traverse own property descriptors without invoking accessors, represent
  accessors with a fixed marker, wrap reflection per object/property, and add Proxy/getter/Error
  accessor tests at both sanitizer and final logger boundaries.
- **Blocking status:** Invalidates the documented redaction/error robustness; remediation is required.

### P0-AUD-009 — Timeout failures lose request and correlation identifiers

- **Severity:** MEDIUM
- **Area:** Observability and context propagation
- **Affected files:** `apps/api/src/bootstrap.ts`,
  `apps/api/src/http/safe-exception.filter.ts`, `packages/observability/src/logger.ts`
- **Description:** Request context is established around the `onRequest` continuation, but the Fastify
  handler-timeout callback executes without that AsyncLocalStorage context. The exception filter uses
  `request.id` for the response but does not pass it explicitly to the logger. `onResponse` relies on
  the same missing ambient context.
- **Reproduction:** In the 25-request real HTTP timeout test, all 25 failure logs and all 25 completion
  logs lacked `requestId`; correlation IDs were absent as well.
- **Evidence:** `evidence/audit/adversarial-probes.json` under `api` records zero correlated records out
  of 25 for both event types.
- **Impact:** The most operationally important slow/failing requests cannot be joined to client error
  envelopes or traces, weakening incident diagnosis and abuse analysis.
- **Root cause:** Correlation depends only on ambient async context across framework-owned timeout
  callbacks instead of attaching normalized IDs to the request and supplying them explicitly at
  response/error hooks.
- **Recommended remediation:** Store immutable normalized context on the Fastify request, restore it
  around every lifecycle hook, and pass IDs explicitly to failure/completion logs. Test timeouts,
  aborts, parser errors, early replies, and shutdown.
- **Blocking status:** Invalidates AC-026; remediation is required for Phase 0 pass.

### P0-AUD-010 — One Moderate advisory is retained without identity or assessment

- **Severity:** MEDIUM
- **Area:** Supply chain and CI evidence
- **Affected files:** `.github/workflows/phase-00.yml`, retained `phase-00-security` artifact,
  repository security settings
- **Description:** Exact-SHA hosted CI reports one Moderate vulnerability but the retained log contains
  only the count and severity. CI intentionally gates only High/Critical and Trivy is filtered the
  same way. Dependabot alerts are disabled, so repository APIs cannot supply the missing advisory.
- **Reproduction:** The downloaded `dependency-audit.log` from run `34007817063` contains only
  `1 vulnerabilities found; Severity: 1 moderate`. A Dependabot alerts query returned HTTP 403 with
  `Dependabot alerts are disabled for this repository`. Local audit detail could not be obtained
  without defeating TLS validation because the host certificate chain was rejected.
- **Evidence:** `evidence/audit/verification-summary.json` under `hostedSecurityArtifact` and
  `localDependencyAudit`.
- **Impact:** Reviewers cannot identify the package, version, runtime/dev scope, exploit conditions,
  fix, or expiry, so the Moderate risk cannot be consciously accepted or prioritized.
- **Root cause:** CI retains human summary output instead of machine-readable audit output and has no
  enabled repository advisory feed. The threshold decision is not paired with an inventory of
  below-threshold findings.
- **Recommended remediation:** Retain sanitized JSON/SARIF with advisory IDs, package paths, scope and
  fixed versions; enable Dependabot alerts if repository policy permits; add a documented triage owner
  and expiry for unresolved Medium/Low findings. Do not weaken TLS to obtain the report.
- **Blocking status:** Requires evidence/triage before Phase 0 can pass; the advisory's exploitability
  remains unclassified.

### P0-AUD-011 — History scan errors are silently treated as an empty result

- **Severity:** LOW
- **Area:** Secret scanning
- **Affected files:** `scripts/security/scan-secrets.ts`
- **Description:** The full-history command has a 20 MiB output cap, and every error is caught as if an
  initialized repository simply had no commits. The scanner then returns working-tree findings and
  can report pass.
- **Reproduction:** Static analysis of the `execFileSync` `maxBuffer` and unconditional catch. A
  destructive or artificially inflated-history reproduction was unnecessary for this target.
- **Evidence:** `scripts/security/scan-secrets.ts` lines 70–79 at the target commit.
- **Impact:** As history grows, buffer exhaustion, Git failures, or permission problems can silently
  remove historical coverage while CI still states the repository secret scan passed.
- **Root cause:** Expected no-history and unexpected execution failures share one catch path.
- **Recommended remediation:** Use a streaming history scan or scan blobs/commits incrementally, treat
  all unexpected Git errors as gate failures, and test a repository whose history exceeds the old
  buffer.
- **Blocking status:** Does not independently block this target because current history was scanned
  successfully by the existing gate, but it should be hardened before repository growth.

## Existing controls successfully challenged

The following controls resisted the attempted challenge at the target commit:

- Git history and tracked-file state were coherent; line-ending attributes reported LF for audited
  text, and `git diff --check` and `git fsck --full --strict` found no reachable-object error.
- Node and pnpm pins matched the running toolchain; the committed lockfile hash remained
  `0c23466cc24c9a04afa5a8c09a065fb648cd0c6ab7772004dfed870cceef3071`.
- The root verification gate passed: format, lint, strict types, current narrow architecture fixture,
  current secret signatures, 322 license records, 33 unit tests, and five builds.
- Missing/malformed configuration, ambiguous booleans, numeric bounds, example credentials, wildcard
  CORS, insecure production origins, and missing OTLP endpoints were rejected by existing tests.
- Oversized body, URL and headers returned bounded safe errors; CORS did not grant credentials;
  unexpected errors returned safe client envelopes even when their logs leaked.
- Liveness stayed independent of PostgreSQL. Readiness returned 503 on loss/hang, remained bounded,
  and recovered after database recreation.
- Empty apply, repeat no-op, transactional failure rollback, ordinary down/up, concurrent application,
  PostGIS presence, simple runtime DDL denial, and outbox insert transaction rollback all passed their
  existing scenarios.
- Worker start/close idempotency passed in process and the exact-SHA hosted Linux signal tests passed.
  The earlier worker premature-exit regression did not recur in the normal SIGTERM scenario.
- The effective PostGIS container ran as UID/GID 70, had zero effective capabilities, could not write
  `/` as that user, could write PGDATA, was healthy, used loopback port publication, and had configured
  CPU/memory limits.
- CI actions were SHA-pinned, job permissions were `contents: read`, timeouts existed, mandatory jobs
  fed the aggregate gate, and all four exact-SHA hosted jobs succeeded. Trivy reported zero known
  High/Critical filesystem and image findings.
- Telemetry provider rejection/hang tests remained bounded and did not crash the unit suite.

## Tests and evidence

| Type              | Execution/result                                                                   |
| ----------------- | ---------------------------------------------------------------------------------- |
| Existing test     | `corepack pnpm verify`: PASS, 33/33 unit tests and five builds                     |
| Existing test     | `corepack pnpm test:integration:local`: PASS 7, SKIP 2 Windows POSIX cases         |
| Existing test     | `corepack pnpm db:verify:local`: PASS, all eight reported booleans true            |
| Hosted execution  | Actions `34007817063`: all four jobs PASS at exact audit target                    |
| Audit-added test  | Error-string, hostile-getter, production DB TLS and architecture-bypass probes     |
| Audit-added test  | Real HTTP 25-way timeout, shutdown/drain, correlation and safe-response probe      |
| Audit-added test  | Disposable DB role escape, outbox-state, privilege and migration-corruption probes |
| Manual inspection | Container identity/capabilities/writes/limits/image; CI; lockfile; docs and code   |
| Limited attempt   | Separate clone succeeded; safe frozen install blocked by host CA/incomplete cache  |

Versioned safe evidence:

- `evidence/audit/audit-target.json`
- `evidence/audit/adversarial-probes.json`
- `evidence/audit/verification-summary.json`

No credential, certificate, raw environment file, database dump, or audit canary value is stored.

## Documentation drift

The audit falsified several claims that remain as historical implementation evidence:

- the redactor does not cover secrets embedded as ordinary error key/value text;
- request timeouts do not bound underlying handler work and shutdown does not drain it;
- timeout failures are not correlated;
- the architecture gate is not robust against common equivalent syntax;
- current migration verification omits unknown-state and down-SQL-drift attacks;
- current runtime DDL verification does not authenticate as an independently restricted login;
- the outbox constraints do not encode a coherent claim/publication state;
- production configuration can represent a non-TLS database connection as valid.

These contradictions are findings, not edits to historical implementation evidence. Remediation must
update code, tests, ADRs/docs where the intended contract changes, and then append a retest section to
this audit rather than deleting this initial record.

## Acceptance criteria after audit

The audit recalculates all criteria instead of carrying implementation labels forward blindly:

- **PASS: 24**
- **FAIL: 11**
- **DEFERRED: 1**

Failed criteria: `AC-008`, `AC-012`, `AC-014`, `AC-019`, `AC-020`, `AC-022`, `AC-026`, `AC-027`,
`AC-030`, `AC-033`, and `AC-035`.

- **AC-031: DEFERRED — PRE-PRODUCTION GOVERNANCE.** It is neither removed nor passed. Reopen it
  before the first production-connected deployment, multiple merge-capable collaborators,
  deployment automation from `main`, exposure of critical real infrastructure, or any Production
  Readiness milestone.
- **AC-035: FAIL.** The adversarial discovery is complete and every finding is recorded, but three
  HIGH findings remain unremediated and un-retested. The criterion explicitly requires that closure.
- **AC-036: PASS.** This `AUDIT.md` exists, records complete counts, residual risk, evidence, deferred
  AC-031 and the truthful failed verdict. This does not make Phase 0 complete.

Criteria not named as failed retain their implementation evidence and survived the relevant audit
challenge. `AC-034` remains a mapping criterion; false implementation conclusions are superseded by
this audit rather than erased.

## Required next stage

The only authorized continuation after this report is **PHASE 0 — AUDIT REMEDIATION**. It must retain
all initial findings, fix them without broadening product scope, rerun adversarial reproductions and
existing gates, reassess every Medium, and append final closure evidence. Phase 1 remains unauthorized.

# PHASE 0 AUDIT FAILED — REMEDIATION REQUIRED
