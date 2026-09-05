# Phase 0 — Foundation and Engineering System — PLAN

**Status:** Ready for stakeholder review  
**Prepared:** 2026-09-04  
**Implementation authorization:** Not granted by this document  
**Depends on:** Approval of this plan and architecture baseline

## 1. Objective

Create a reproducible, secure, observable, and enforceably modular repository foundation on which Trayvi domain phases can be implemented. Phase 0 proves the engineering system, not any product workflow.

## 2. Scope

### Included

- initialize Git and baseline repository governance;
- pin Node.js and pnpm versions and establish workspace/task orchestration;
- create only the API, worker, and shared foundation packages needed to prove architecture;
- establish strict TypeScript, lint, formatting, dependency-boundary, test, and build rules;
- configure PostgreSQL/PostGIS local development and reviewed SQL migration tooling;
- add a baseline migration containing only platform metadata needed to prove migrations if necessary; no product tables;
- implement typed environment/configuration validation with fail-fast behavior;
- implement structured logging, recursive sensitive-field redaction, request/correlation IDs, safe errors, and OpenTelemetry hooks;
- implement unauthenticated liveness/readiness endpoints with deliberately minimal responses;
- establish transactional/outbox interfaces and conventions; a minimal technical outbox table may be created only if exercised by a real integration test;
- create unit and real-database integration harnesses;
- create CI checks for install, formatting, lint, typecheck, architecture, tests, migration validation, build, dependency/secret scanning, and generated-contract drift where present;
- create Dockerfiles/local Compose only to the extent needed for reproducible execution;
- create baseline ADRs, developer setup, configuration reference, threat model, and operational notes;
- audit and remediate Phase 0.

### Excluded

- accounts, credentials, OTP, sessions, identity documents, roles, permissions, or recovery;
- countries, markets, zones, driver positions, product seed data, including Villa Altagracia;
- drivers, vehicles, pricing, trips, dispatch, realtime, ratings, payments, merchants, orders, promotions, or fraud rules;
- user-facing customer/driver/admin functionality;
- selection of payment, identity, maps, SMS, or biometric vendors;
- production cloud provisioning or deployment;
- claims of legal/regulatory compliance or production/pilot readiness.

Any scaffold that resembles an excluded feature must be removed or explicitly demonstrated to contain no fake implementation.

## 3. Functional requirements

### FR-0.1 Reproducible workspace

A documented fresh clone can install from the lockfile, run local required services, migrate a disposable database, execute checks, and start the API/worker using pinned tooling.

### FR-0.2 API process

The API starts only after configuration validation. It assigns/propagates request and correlation identifiers, emits structured safe logs, maps unexpected failures to a non-sensitive error, and handles graceful shutdown.

### FR-0.3 Health

- `GET /health/live` answers only whether the process is responsive.
- `GET /health/ready` reflects database readiness with bounded timeout.
- Responses contain status and safe component names only; no connection strings, hostnames, exception messages, environment variables, or stack traces.
- Health endpoints are excluded from noisy access logs or sampled deliberately, while failures remain observable.

### FR-0.4 Worker process

The worker starts with the same validated configuration/observability baseline and shuts down gracefully. If an outbox slice is implemented, one integration test proves retry/idempotency behavior without requiring a production broker.

### FR-0.5 Database lifecycle

Commands apply all migrations to an empty PostGIS-enabled database, report current status, and support a safe local rollback or disposable-database reset procedure. CI proves both clean migration and the defined rollback/roll-forward path.

### FR-0.6 Engineering checks

One root command runs the required static/test/build checks. Workspace task dependencies are deterministic and CI uses the frozen lockfile.

### FR-0.7 Documentation and decisions

The delivered repository explains setup, architecture boundaries, commands, configuration, migrations, tests, security, observability, contribution conventions, and known limitations. Required Phase 0 ADRs are accepted or their unresolved decision explicitly blocks implementation.

## 4. Non-functional requirements

### Security

- No committed secret; secret scanning covers full tracked content and relevant history once Git exists.
- Configuration schema distinguishes secret values and never prints them on validation failure.
- General logs redact sensitive keys recursively and case-insensitively, including nested arrays/objects.
- CORS is denied unless explicit allowed origins are configured; no credentialed wildcard.
- HTTP body and query logging is off by default.
- Container images/processes run non-root where supported and expose only required ports.
- Dependencies and images have scan results; Critical/High exploitable findings block the phase unless fixed. Risk acceptance requires stakeholder authority and cannot be self-approved.

### Reliability

- Startup fails fast on invalid required configuration.
- Database probes and external hooks use timeouts; shutdown stops new work and drains bounded in-flight work.
- API and worker do not rely on local process memory for durable state.
- Migration failure is non-destructive and returns a non-zero status.

### Maintainability

- TypeScript strictness is enabled without blanket escape hatches.
- Module/package dependency directions are machine-enforced.
- Production code does not import test-support packages.
- Architectural and configuration conventions have examples/tests.

### Performance

- Baseline health endpoint has a locally documented measurement, with readiness dependency time bounded.
- Logging is non-blocking/buffered according to selected library behavior and avoids unbounded payload serialization.
- No Phase 0 performance target is represented as production capacity.

### Portability

- Developer workflow supports Windows/PowerShell (current environment) and CI's selected Linux runner.
- Line endings, paths, scripts, and containers do not depend on a single developer's absolute path.

## 5. Architecture and planned components

### Workspace units created in this phase

```text
apps/api
apps/worker
packages/config
packages/observability
packages/test-support
```

`packages/contracts` is added only if the health/error OpenAPI artifact or shared event envelope provides demonstrated value. Business `modules/*` are not created in Phase 0.

### Dependency rules

- Apps may depend on foundation packages.
- Foundation packages may not depend on apps.
- Config has no dependency on observability; validation errors are representable without revealing values.
- Observability may consume safe config interfaces, never the entire raw environment.
- Test support is importable only from tests.
- Future domain modules may depend on shared kernel primitives that are proven generic, but not on another module's infrastructure.

An automated architecture test or lint rule must fail on at least one intentionally invalid fixture/example during test development, proving the rule is active.

## 6. Database plan

- Use a supported PostgreSQL release with compatible PostGIS image, pinned by immutable version/digest policy recorded in ADR-003.
- Use separate logical credentials for migration and runtime in production design; local development may use simplified credentials clearly labeled non-production.
- Schema migrations are reviewed SQL stored under a single canonical directory.
- The first migration enables/verifies required extensions and may create migration/outbox technical structures only. No account, user, market, or trip table is permitted.
- Migrations execute under an advisory lock to prevent concurrent migration runners if the chosen tool does not already guarantee this.
- Runtime startup never automatically performs production migrations.
- Integration tests use an isolated database/schema per suite or worker and clean up deterministically.

### Migration verification matrix

1. Empty database -> latest succeeds.
2. Latest schema matches expected migration status.
3. Re-running is a no-op.
4. Down/rollback strategy works for the Phase 0 migration, or a documented roll-forward simulation proves the selected immutable approach.
5. Invalid migration exits non-zero without silently marking success.
6. Concurrent migration invocation is serialized or one exits safely.

## 7. Configuration and environment contract

Configuration categories include runtime environment, bind address/port, database URL or structured fields, log level/format, service name/version, allowed origins, telemetry endpoint/enablement, and shutdown/probe timeouts.

Rules:

- development, test, staging, and production are explicit values;
- unknown/missing/invalid critical values fail before accepting traffic;
- production cannot use known example/default secrets or permissive CORS;
- `.env.example` contains names and safe examples only;
- no source file reads `process.env` outside the config composition boundary;
- validation errors identify the field and constraint, never the secret value;
- tests cover missing, malformed, mutually inconsistent, and production-unsafe values.

## 8. API, error, and observability conventions

### Request context

- Accept a syntactically valid inbound request/correlation ID within length/character limits; otherwise generate a new opaque ID.
- Return request ID in response headers.
- Propagate correlation/trace context to internal work and future outbound adapters.
- Do not treat caller-provided IDs as trusted authorization/audit identity.

### Error envelope

Use Problem Details semantics with fields such as `type`, `title`, `status`, stable `code`, `requestId`, and optional safe validation violations. Production never returns stack traces, SQL/provider details, filesystem paths, or raw input.

### Structured log baseline

Required safe fields: timestamp, level, service, environment, version, event, request/correlation/trace ID where available, outcome, duration. Actor/resource IDs are introduced only by later authenticated/domain phases.

The redactor test corpus includes `password`, `passcode`, `otp`, `authorization`, `cookie`, `token`, `refreshToken`, `secret`, `apiKey`, `documentNumber`, `cedula`, payment/card fields, nested keys, alternate casing, arrays, error causes, and URL query values.

### Metrics/tracing

Expose or collect request count/duration/errors, process/runtime signals, DB pool/probe behavior, and worker lifecycle. Metrics endpoints, if any, are not publicly exposed by default. Trace export failure does not crash the business process and does not log payload secrets.

## 9. Interfaces

Foundation interfaces are intentionally narrow:

- `AppConfig`: validated immutable configuration view.
- `Logger`: structured event methods accepting pre-sanitized context plus central last-line redaction.
- `RequestContext`: request, correlation, trace, and future principal references.
- `HealthCheck`: named, timeout-bound readiness result with safe public projection.
- `Clock` and `IdGenerator`: injectable deterministic ports for tests and future domain code.
- `TransactionRunner`: infrastructure-neutral transaction boundary interface only if exercised.
- `OutboxPublisher`/event envelope: introduced only with a tested outbox slice.

Avoid a broad generic repository, base entity, event bus, or global service locator.

### Phase 0 runtime flow

1. The process loads raw environment input through the single composition boundary.
2. The configuration package validates and returns an immutable safe view or terminates before binding a port.
3. Observability initializes with safe service/version/environment fields; exporter failure is bounded.
4. The API/worker initializes required resources and registers shutdown handlers.
5. The API binds only after initialization; liveness then reports process responsiveness and readiness evaluates its bounded dependency probe.
6. On termination, readiness fails first, new work stops, bounded in-flight work drains, resources close, and the process exits with a truthful status.

## 9A. State, invariants, and permissions

Phase 0 introduces no persistent business state machine. The only lifecycle modeled is the runtime lifecycle `CREATED -> INITIALIZING -> READY -> DRAINING -> STOPPED`, with `FAILED` possible before readiness or after an unrecoverable runtime error. Readiness is a projection of lifecycle and required dependency health, never a durable domain state.

Foundation invariants are:

- a process never accepts traffic before critical configuration validation succeeds;
- liveness never depends on PostgreSQL or an external telemetry provider;
- readiness never reports ready when its required database probe exceeds the configured timeout or fails;
- shutdown marks the instance unready before draining and closes resources at most once;
- a request has exactly one effective request ID and correlation ID after ingress normalization;
- unsafe inbound correlation values are not echoed or logged;
- a migration version is applied at most once, and concurrent runners cannot both apply it;
- application runtime credentials cannot alter schema under the production grants design;
- no Phase 0 component contains or simulates a Trayvi product workflow.

Phase 0 has no end-user RBAC because it has no accounts or protected product APIs. Infrastructure permissions still follow least privilege:

- the migration principal may perform only required schema changes;
- the runtime principal may use only runtime schema objects and cannot grant roles or perform DDL;
- CI jobs default to read-only repository contents and receive write/identity/environment permission only in a separately approved deployment workflow;
- health endpoints reveal only safe status; operational metrics are bound privately or protected by infrastructure controls;
- no database console, debug endpoint, or generic environment/configuration endpoint is exposed.

## 9B. Alternatives considered and rejected

| Alternative                                                     | Decision and reason                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Microservices from inception                                    | Rejected: creates deployment, consistency, observability, and ownership costs before scaling/team evidence exists.                       |
| Single unstructured application folder                          | Rejected: makes domain ownership and later extraction difficult to enforce.                                                              |
| ORM-generated schema as sole migration definition               | Rejected: critical constraints, PostGIS, privileges, and lock behavior require explicit reviewable SQL.                                  |
| In-memory/SQLite integration tests                              | Rejected: cannot prove PostgreSQL transactions, constraints, migrations, privileges, or PostGIS behavior.                                |
| Redis/message broker in Phase 0                                 | Deferred: no product workload yet justifies another stateful dependency. Transactional outbox conventions preserve an introduction path. |
| Automatic migrations on API startup                             | Rejected for production: replica races and schema/runtime coupling make controlled deployment unsafe.                                    |
| Custom authentication/RBAC scaffold now                         | Rejected: it would be placeholder product functionality ahead of the owning phase and threat model.                                      |
| One combined readiness/liveness probe                           | Rejected: dependency loss must remove traffic without causing process restart loops.                                                     |
| Logging complete request/response bodies                        | Rejected: creates disproportionate privacy and secret-leak risk.                                                                         |
| Exact framework/test/database patch versions frozen in the plan | Deferred to implementation ADRs: compatibility must be verified together, then lockfile/image pins become the executable record.         |

## 10. Security threat model

### Assets

Repository integrity, CI credentials, dependency graph, environment secrets, database credentials/data, logs/traces, build artifacts, and deployment configuration.

### Actors

Developer, CI service, runtime service, database administrator, malicious dependency maintainer, external attacker, and compromised developer workstation.

### Trust boundaries

Developer to repository; package registry to CI; CI to artifact store; runtime to database/telemetry; inbound network to API; configuration/secrets provider to process.

### Threats and mitigations

| Threat                         | Severity if unmitigated | Required mitigation/evidence                                                               |
| ------------------------------ | ----------------------: | ------------------------------------------------------------------------------------------ |
| Secret committed or emitted    |                Critical | Ignore rules, secret scan, safe examples, redaction/error tests                            |
| Dependency/build compromise    |                    High | Frozen lockfile, minimal lifecycle scripts policy, scans, reviewed updates, CI permissions |
| Injection via logs/headers     |                  Medium | ID validation, structured fields, newline/control-character handling, payload bounds       |
| Readiness leaks topology       |                  Medium | Safe fixed response model and tests                                                        |
| Permissive CORS/default config |                    High | Fail-closed production validation and tests                                                |
| Migration race/corruption      |                    High | Locking/transaction behavior and real-DB tests                                             |
| Boundary erosion               |                  Medium | Automated imports/architecture tests and ownership docs                                    |
| CI token overreach             |                    High | Least permissions, protected environments, no secrets on untrusted jobs                    |
| Unbounded requests/shutdown    |                    High | Body/time limits, graceful drain, dependency timeout tests                                 |
| Telemetry data exfiltration    |                    High | Allowlisted fields/redaction, TLS endpoint, exporter failure tests                         |

### Residual risks

Cloud IAM, WAF/DDoS, artifact signing, managed key custody, backup restore, and production network topology remain unresolved until a hosting decision. Phase 0 must document them as blockers for production, not imply they are implemented.

## 11. Testing strategy and required cases

### Tooling decision spike

Evaluate the NestJS-compatible test runner candidates against ESM/TypeScript support, mocking isolation, coverage, watch performance, Testcontainers, IDE debugging, and maintenance health. Record the choice in ADR-010. The spike may contain disposable code; only the chosen setup remains.

### Unit tests

- configuration parsing and unsafe production combinations;
- ID acceptance/generation and control-character rejection;
- recursive redaction including errors/nested structures;
- safe error mapping;
- readiness result projection and timeout behavior;
- graceful-shutdown coordination.

### Integration tests

- API live/ready behavior with database available/unavailable;
- empty-database migrations and migration status;
- runtime DB permissions design/test where local roles support it;
- request/correlation propagation through logs and response;
- worker startup/shutdown and outbox behavior if included;
- CORS allowed/disallowed origin behavior.

### Static/architecture tests

- strict typecheck;
- lint/format;
- workspace dependency boundaries;
- no direct environment reads outside config boundary;
- no production import from test support;
- OpenAPI lint/drift if generated;
- dependency and secret scans.

### Failure tests

- invalid config, unavailable DB, readiness timeout, telemetry endpoint failure, migration failure, SIGTERM during in-flight request/job, malformed/oversized request, and logging of a deliberately nested sensitive fixture.

## 12. CI plan

Pull-request CI uses least permissions, concurrency cancellation, explicit timeouts, dependency caching keyed by lockfile, and no production secrets. Jobs/stages:

1. policy/secret scan;
2. frozen install and toolchain verification;
3. format, lint, typecheck, architecture checks;
4. unit tests with machine-readable result and coverage artifact;
5. PostgreSQL/PostGIS integration and migration matrix;
6. build API/worker and container images if included;
7. dependency/image/license scans;
8. generated API contract drift check;
9. summary gate requiring all mandatory jobs.

Branch protection and reviewer ownership are documented for the hosting platform but cannot be proven until a remote repository exists.

## 13. Documentation deliverables

- Root `README.md` with truthful status and quick start.
- `CONTRIBUTING.md`, code/conventional-commit guidance, and review checklist.
- `docs/architecture` overview and accepted Phase 0 ADRs.
- `docs/security/THREAT_MODEL_PHASE_00.md` and secure development checklist.
- configuration and local-development references.
- migration and test guides.
- observability field/redaction specification.
- operations note for health, startup/shutdown, and known production blockers.
- `IMPLEMENTATION.md` with acceptance evidence.
- `AUDIT.md` with findings, remediation, rerun evidence, and PASS/FAIL.

## 14. Exact acceptance criteria

Every item is mandatory unless explicitly marked conditional.

### Repository and reproducibility

- [ ] AC-001 Git is initialized; default branch and line-ending policy are documented; no generated/secrets files are tracked.
- [ ] AC-002 Runtime and package-manager versions are pinned; CI verifies them.
- [ ] AC-003 A clean checkout follows the documented setup without undocumented global tools other than Git, container runtime, and pinned Node/package manager bootstrap.
- [ ] AC-004 Frozen install succeeds from the committed lockfile.
- [ ] AC-005 A single documented root verification command completes locally and in CI.

### Architecture and code quality

- [ ] AC-006 Workspace contains only justified Phase 0 apps/packages; no functional domain placeholder exists.
- [ ] AC-007 Strict typecheck, lint, format check, and build pass with zero errors.
- [ ] AC-008 Automated boundary checks pass and a test/fixture proves a forbidden dependency is detected.
- [ ] AC-009 Direct environment access is confined to the configuration composition boundary.
- [ ] AC-010 Required ADR-001 through ADR-010 are accepted and consistent with code, or the phase fails.

### Configuration and security

- [ ] AC-011 Missing/malformed critical configuration causes fail-fast startup with no secret value printed.
- [ ] AC-012 Production-unsafe defaults, wildcard credentialed CORS, or example secrets are rejected.
- [ ] AC-013 Repository secret scan passes; `.env.example` contains no usable credential.
- [ ] AC-014 Recursive redaction tests pass for the documented corpus, nested data, arrays, mixed case, error objects, headers, and URLs.
- [ ] AC-015 Unexpected API errors return a stable safe envelope with request ID and no stack/query/path/input leak.
- [ ] AC-016 Dependency/container scans contain no unresolved exploitable Critical or High issue; any non-exploitable exception has external stakeholder acceptance, owner, evidence, and expiry.

### Database and migrations

- [ ] AC-017 A pinned PostgreSQL/PostGIS local service becomes healthy through documented commands.
- [ ] AC-018 All migrations apply to an empty disposable database and a second run is a no-op.
- [ ] AC-019 Migration rollback/roll-forward, failure, and concurrent-run behaviors match the documented strategy and have automated evidence.
- [ ] AC-020 The runtime path cannot perform schema DDL under the production role design; this is tested where feasible and otherwise demonstrated by reviewed grants script.
- [ ] AC-021 No product/domain table or Villa Altagracia hardcoding exists.

### Runtime and observability

- [ ] AC-022 API and worker start with structured logs and stop gracefully within the configured bound.
- [ ] AC-023 Liveness succeeds without querying dependencies; readiness becomes non-ready when DB is unavailable and recovers when restored.
- [ ] AC-024 Health/error responses do not expose secrets, topology, dependency exception text, or configuration.
- [ ] AC-025 Valid request/correlation IDs propagate; malformed/oversized/control-character values are replaced safely; response contains the effective request ID.
- [ ] AC-026 Metrics/traces/logs use documented low-risk fields; telemetry exporter failure is bounded and does not crash or leak payloads.
- [ ] AC-027 Request body size, server/request timeout, readiness timeout, and graceful-shutdown limits are explicit and tested.

### Testing and CI

- [ ] AC-028 Unit and integration suites pass on the supported Windows developer path and selected Linux CI runner.
- [ ] AC-029 Integration tests execute against real PostgreSQL/PostGIS and are isolated/repeatable.
- [ ] AC-030 Failure-path tests cover invalid config, DB loss, telemetry loss, malformed/oversized request, migration failure, and shutdown.
- [ ] AC-031 CI is triggered for pull requests and protected-branch changes, uses least permissions/timeouts, and all required jobs pass.
- [ ] AC-032 Test, scan, migration, and build evidence is retained as links/artifacts in `IMPLEMENTATION.md` or the CI run.

### Documentation and audit

- [ ] AC-033 README/setup, architecture, config, migration, test, security, observability, and operations documentation match actual commands/behavior.
- [ ] AC-034 Phase 0 implementation report maps AC-001–AC-033 to concrete evidence.
- [ ] AC-035 An adversarial audit is completed using Section 15, every finding is recorded, and all Critical/High findings are remediated and retested.
- [ ] AC-036 `AUDIT.md` reports final counts, residual risks, evidence, and `PASS`; otherwise Phase 0 is not complete.

## 15. Audit plan

The auditor approaches the implementation as untrusted and attempts to falsify each acceptance claim.

### Independence procedure

- Audit occurs after implementation evidence is frozen.
- Start from a clean checkout/disposable environment, not the developer's running state.
- Reproduce commands rather than accepting screenshots or author assertions.
- Inspect diffs, lockfile, generated files, container definitions, migration SQL, CI permissions, and transitive dependencies.
- Seed canary secrets/document/token/location values and search every captured log, error, trace, metric/export payload, and CI artifact for leakage.
- Add or run negative/adversarial cases rather than only rerunning happy paths.

### Audit work program

| Area            | Procedure                                                                  | Blocking examples                                 |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Correctness     | Trace FRs and ACs to executable evidence; fresh-start/stop/restart         | Health lies, setup is not reproducible            |
| Architecture    | Try forbidden imports/direct env access; inspect coupling and global state | Boundary controls absent or bypassable            |
| Security        | Secret scan; CORS/error/header/body-limit tests; dependency/image analysis | Secret leak, permissive production config         |
| Privacy         | Canary leakage search across all telemetry/artifacts                       | Restricted data emitted                           |
| Data integrity  | Empty/repeat/failing/concurrent migrations; inspect constraints/grants     | Corruption or false migration success             |
| Concurrency     | Start simultaneous migration/worker actions where applicable               | Multiple unsafe executors, duplicate effects      |
| Error handling  | Remove DB/telemetry, inject malformed config/input, terminate process      | Hang, unsafe error, corrupted state               |
| Observability   | Correlate request and failure without sensitive payload                    | Incident cannot be investigated safely            |
| Performance     | Basic health/load probe and payload-bound test                             | Unbounded resource use or readiness cascade       |
| Supply chain    | Review scripts, lockfile drift, CI permissions, scans, base images         | Unpinned/unreviewed execution or exploitable High |
| Maintainability | Compare docs/ADRs/code; run supported OS workflows                         | Undocumented globals, stale instructions          |

### Severity rubric

- **CRITICAL:** likely severe compromise, safety/data loss, secret exposure, arbitrary code/privilege, or unrecoverable integrity failure.
- **HIGH:** practical authorization/security bypass, sensitive leak, migration corruption, non-reproducible foundation, exploitable supply-chain issue, or missing enforcement for a core invariant.
- **MEDIUM:** meaningful weakness with constraints/mitigation; should be scheduled with owner/date.
- **LOW:** limited impact or defense-in-depth/maintainability issue.
- **INFO:** observation or improvement without a current defect.

### Required audit report format

`AUDIT.md` includes scope, commit/artifact identity, environment, commands, acceptance matrix, findings with severity/evidence/impact/remediation, changes made, full retest results, residual risks, final counts, and `PASS` or `FAIL`. A Critical/High finding makes the initial decision `FAIL`; after remediation the same case and regression suite are rerun and the report records both original and resolved state.

## 16. Implementation sequence after approval

1. Record and accept Phase 0 ADRs and repository governance.
2. Pin toolchain and create minimal workspace/task graph.
3. Implement config and test-runner spike/decision.
4. Add PostgreSQL/PostGIS local service and migration harness.
5. Add observability/request context/safe errors.
6. Add API/worker lifecycle and health behavior.
7. Add security/static/boundary/failure/integration tests.
8. Add CI and container/build validation.
9. Complete documentation and implementation evidence.
10. Perform adversarial audit, remediate, rerun, and decide PASS/FAIL.

## 17. Risks and open decisions

These do not block plan readiness but must be resolved during Phase 0 before implementation can pass:

- exact supported Node/NestJS/PostgreSQL/PostGIS patch versions;
- Vitest versus Jest based on the defined spike;
- migration tool selection and down-migration policy details;
- CI/remote Git hosting platform and enforceable branch protections;
- production hosting, IAM, KMS, artifact registry, RPO/RTO, and region remain later operational decisions and explicit production blockers;
- repository license and code ownership require stakeholder input.

## 18. Exit decision

This plan is sufficiently detailed to begin Phase 0 implementation after stakeholder approval. Phase 0 itself remains **NOT STARTED** and cannot be called complete until AC-001 through AC-036 are evidenced and the final audit decision is `PASS`.

**READY FOR PHASE 0 IMPLEMENTATION**
