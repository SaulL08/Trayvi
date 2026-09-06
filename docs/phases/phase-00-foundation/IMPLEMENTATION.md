# Phase 0 — Foundation and Engineering System — IMPLEMENTATION

**Status:** Implementation verified locally; external acceptance gates pending  
**Started:** 2026-09-04  
**Authority:** [PLAN.md](PLAN.md)

This is the contemporaneous implementation record. It records only executed evidence; the separate
adversarial audit required by AC-035 and AC-036 is not part of this implementation pass.

## Baseline inspection

- Planning, architecture, financial guardrail, security, Trust & Safety, ADR, design, and provisional
  brand documents were reread before modification.
- The workspace contained documentation and the provisional v2.2 brand kit, but no application,
  package manifest, lockfile, CI workflow, database schema, or Git repository.
- Git `2.50.0.windows.1`, Node `22.14.0`, npm `10.9.2`, Corepack `0.31.0`, Docker
  `29.7.2`, and Docker Compose `5.4.0` were observed. pnpm was not preinstalled globally.
- Git was initialized on branch `main`. The isolated implementation account triggers Git's dubious
  ownership protection, so validation uses a per-command `safe.directory` override without changing
  the developer's global Git configuration.
- The provisional logo remains documentation/reference only; no UI or brand package is introduced.

## Decisions resolved during implementation

- Supported runtime baseline: Node `22.14.0` and pnpm `11.25.0` through Corepack.
- NestJS/Fastify package versions are lockfile-pinned after compatibility installation.
- Vitest is the Phase 0 runner (ADR-010).
- Migrations use reviewed paired SQL files plus a small repository-owned runner with a PostgreSQL
  advisory lock and transactional migration records (ADR-003).
- PostgreSQL outbox is technical infrastructure only; no broker or product event is introduced.
- CI target is GitHub Actions. Remote branch protection and CODEOWNERS identities remain externally
  blocked until repository hosting and owners exist.

## Work log

### 2026-09-04 — repository and governance

- Initialized Git on `main`.
- Added line-ending, ignore, editor, toolchain, workspace, contribution, and security policy files.
- Began the AC-001–AC-034 evidence record before implementation proceeded.

### 2026-09-04 — package bootstrap

- Corepack initially rejected the local TLS inspection chain with
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; SSL verification was not disabled.
- Exported the workstation's public Avast inspection CA to the ignored `.docker-local` directory and
  supplied it through `NODE_EXTRA_CA_CERTS` only for dependency operations in this environment.
- Confirmed pnpm `11.25.0` and moved pnpm 11 settings to `pnpm-workspace.yaml`.
- Replaced removed `onlyBuiltDependencies` syntax with an explicit `allowBuilds` map. Only Nest's
  framework compilation hook and esbuild are approved to run dependency build scripts.
- The initial dependency resolution exposed a peer incompatibility between TypeScript `7.0.2` and
  `typescript-eslint 8.69.0`; TypeScript was pinned to compatible stable `6.0.3` and Vite `8.2.2` was
  declared explicitly. `pnpm peers check` then reported no issues.
- `prom-client 15.1.3` was rejected after the registry marked it replaced by
  `@prometheus-io/client`; Phase 0 uses a bounded internal low-cardinality metrics registry instead of
  retaining a deprecated dependency.

### 2026-09-04 — implementation slices

- Added the accepted ADR-001 through ADR-010 set and linked the ADR register.
- Added typed configuration, structured/redacted logging, request context, UUIDv7 IDs, telemetry,
  bounded metrics, and shutdown primitives.
- Added NestJS/Fastify API and Nest application-context worker foundations with no product routes or
  jobs.
- Added PostgreSQL/PostGIS Compose, generated local-only environment setup, reviewed role/bootstrap
  SQL, a technical outbox migration, and the transactional/checksummed/advisory-locked SQL runner.
- Added architecture and secret policy checks plus initial unit/integration test cases.
- Running the formatter also normalized existing Markdown planning/design files. This was a
  formatting-only change (no requirement, status, scope, or acceptance criterion was intentionally
  changed) and is recorded here rather than treated as silent plan change.

### First verification cycle

- `corepack pnpm format`: passed; exposed the Markdown normalization noted above.
- `corepack pnpm typecheck`: failed initially because TypeScript 6 deprecates `baseUrl`; the obsolete
  setting was removed instead of suppressing the warning. Retest pending.
- The next type pass exposed a declaration defect in newly released Vitest `5.0.0`; the test spike was
  pinned to maintained Vitest `4.1.1` with Vite `7.3.6`, preserving `skipLibCheck: false`.
- `@types/node 22.20.1` was selected within the Node 22 line after `22.14.0` proved incompatible with
  TypeScript 6's stricter declaration checking.
- Windows policy prevented Corepack from writing shims under `Program Files`; pnpm `11.25.0` is also
  a root dev dependency so Turborepo can discover a repository-local binary. Corepack remains the
  clean-checkout bootstrap.
- After continuation, `corepack pnpm format`, `lint`, and strict `typecheck` all passed. The compiler
  cycle corrected explicit Fastify request typing, HTTP 431 handling, type-only imports, PostgreSQL
  pool-client typing, and a blank optional OTLP endpoint produced by the local environment generator.
- `corepack pnpm build` passed for all five workspaces. The first unit/policy run then exposed two
  harness assumptions: the environment-access rule matched its own string literal, and the toolchain
  check attempted a globally discoverable pnpm binary. The architecture check now inspects actual
  TypeScript property access through the compiler AST, and the toolchain check invokes pinned pnpm
  through its repository-local pinned entry point.
- Added the root quick start plus architecture, local setup, configuration, migration, testing,
  threat-model, secure-development, observability, and operations references required by the plan.
- Pulled `postgis/postgis:17-3.5` and pinned the resolved manifest-list digest
  `sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6` in local Compose and CI.
- Added GitHub Actions pull-request/main gates for frozen install, toolchain, quality, real PostGIS,
  migration/process integration, dependency/secret/Trivy scans, and retained logs. Third-party actions
  are pinned to their verified release commit SHAs rather than mutable tags.
- Expanded adversarial redaction coverage and added request-log, safe exception-filter, and compiled
  Linux `start -> SIGTERM -> stop` tests. The POSIX child-signal case is skipped on Windows, where Node
  cannot deliver equivalent graceful child SIGTERM semantics; in-process API/worker drain tests remain
  active there.
- The first execution of `local:env` found that Windows PowerShell 5's .NET surface lacks the static
  `RandomNumberGenerator.Fill` API. No file had been written; the generator was changed to the
  compatible `RandomNumberGenerator.Create().GetBytes()` API without weakening randomness.
- The same Windows PowerShell 5 run also lacked `.NET Convert.ToHexString`; the byte-to-hex step now
  uses compatible `BitConverter` output with separators removed. Again, failure occurred before any
  environment file write.
- The first real-database invocation exposed two undeclared pnpm consumers rather than a database
  defect: root migration scripts require `pg`, and API integration tests require
  `@trayvi/test-support`. Both are now explicit development dependencies at their consuming boundary;
  no hoisting assumption is used.
- Rebuilding dependencies under non-interactive `CI=true` exposed pnpm 11's environment-dependent
  `enableGlobalVirtualStore` default: later developer commands correctly detected a settings mismatch
  and tried to self-install, which also needs a direct shim. The workspace now fixes
  `enableGlobalVirtualStore: false`, making install/run state identical on developer and CI paths.
  A legitimate `corepack enable` was attempted again but Windows denied writes under `Program Files`;
  no global configuration or PATH hack was introduced.
- Local Trivy `0.70.0` scanning invalidated the initial database-image choice. The Debian 11 image
  reported 21 Critical and 156 High OS findings plus 56 High/Critical findings in `gosu`; Debian 11
  was also reported unsupported. The upstream Alpine 3.24 variant reduced this to one Critical and
  23 High, all with fixes: two `libexpat` findings and 22 Go-standard-library findings in the unused
  `gosu` helper. A minimal image now pins the Alpine manifest digest, installs the fixed
  `libexpat=2.8.4-r0`, removes `gosu`, and declares the `postgres` user. It must pass a fresh scan and
  DB matrix before being accepted.
- The first non-root image start correctly exposed a persistent-volume ownership incompatibility:
  Alpine's `postgres` UID differs from the prior Debian image. The image now installs exact
  `su-exec=0.3-r0` and exposes it through the `gosu`-compatible path. Its final stage explicitly
  declares UID/GID 70, and a fresh named volume inherits the owned data directory; neither entrypoint
  nor database server starts as root. The earlier scan result is invalidated until this revision is
  rescanned.
- A second scan showed that filesystem replacement alone leaves the removed Go binary visible to a
  layer-aware scanner (one Critical, 21 High). The final `scratch` stage now copies only the hardened
  filesystem, eliminating deleted lower-layer content. Trivy then reported **0 High/Critical**. A
  repository misconfiguration scan subsequently required the runtime identity to be declared in the
  Dockerfile as well as observed at runtime; that final revision must be rebuilt, started with fresh
  storage, rescanned, and rerun through the database matrix before acceptance.
- Integration logs revealed that CORS preflight could finish before the later request-context hook.
  Hook registration now precedes Helmet/CORS registration, and integration assertions require request
  and correlation IDs on both allowed and denied-origin preflight paths.

## Evidence commands

### Final continuation — 2026-09-04 local / 2026-09-05 UTC

- Reconstructed the current workspace with status, both diffs, the untracked file inventory, PLAN,
  IMPLEMENTATION, ADRs 001–010, and the modified timeout tests. Git has no commits, so both diffs are
  empty; untracked files, rather than an absent diff, were inspected as the source of truth.
- Confirmed the handler test expects `SERVICE_UNAVAILABLE`. The targeted rerun passed, with the
  completion log measuring 115.66 ms against a configured 100 ms timeout and a 400 ms test ceiling.
  Safe-envelope unit tests also passed. Production error behavior was not changed.
- The existing deterministic shutdown test passed. Added a real-clock stalled-task test: a 100 ms
  deadline must resolve within 80–1000 ms and emit structured `outcome=timeout`, without error or task
  payload. All three shutdown tests passed on Windows and Linux.
- Added a real TCP blackhole readiness test. The peer accepts TCP but never answers the PostgreSQL
  protocol; readiness returns safe 503 near its 100 ms deadline, and liveness remains healthy.
- The final Windows root gate passed with 33 unit tests. Integration passed 7 tests with exactly two
  POSIX child-signal tests skipped. The separate migration/DB command returned all eight invariants
  true. Unit coverage also ran successfully; its percentages are diagnostic and exclude integrations.
- Repeated clean Linux verification using Node 22.14.0 bookworm-slim, Git, an empty pnpm store, no
  node_modules/build/cache/environment files from the host, and a separate fresh PostGIS container.
  Frozen install, the exact root `verify` command (including secrets/licenses), coverage, all 33 unit
  tests, all 9 integration tests, and all eight database invariants passed. Compiled API and worker
  received real SIGTERM and exited with code 0. Temporary Linux containers and network were removed.
- The Linux run is a clean source-snapshot run, not a checkout of a commit and not a hosted
  ubuntu-24.04 GitHub Actions execution. These distinctions remain in the acceptance matrix.
- Confirmed the unchanged PostGIS image identity and `USER=70:70`, and the local service is healthy.
  Earlier fresh-storage initialization and final image scan remain valid because image/dependencies
  have not changed. Repository scan was repeated after the CI/test changes: 0 High/Critical
  vulnerabilities, 0 secrets, 0 High/Critical misconfigurations, including development dependencies.
- Corrected the invalid Trivy action SHA to the actual v0.36.0 commit
  `ed142fd0673e97e23eac54620cfb913e5ce36c25`, verified against the
  [official release](https://github.com/aquasecurity/trivy-action/releases/tag/v0.36.0).
  Other action SHAs resolve to their official metadata. Trivy CLI is explicitly v0.70.0. Added JSON
  test/coverage artifacts and the final required-job summary gate. CI has not run remotely.
- No dependency version changed in this closing continuation. No domain feature or formal audit was
  introduced. The original plan's checkboxes are preserved; this matrix records the actual result.

### Executed commands and retained evidence

| Command / check                                                                                                                                                                              | Result and evidence                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `node --env-file=.env.api node_modules/vitest/vitest.mjs run --project integration apps/api/test/api-foundation.integration.test.ts -t 'bounds slow handlers'`                               | PASS; safe 503, 115.66 ms completion log                                                                                                |
| `corepack pnpm exec vitest run --project unit apps/api/test/problem-details.unit.test.ts apps/api/test/safe-exception-filter.unit.test.ts packages/observability/test/shutdown.unit.test.ts` | PASS; targeted envelope and deterministic shutdown checks                                                                               |
| `corepack pnpm exec vitest run --project unit packages/observability/test/shutdown.unit.test.ts`                                                                                             | PASS; 3 tests including real-clock stalled task                                                                                         |
| `corepack pnpm exec vitest run --project integration apps/api/test/readiness-timeout.integration.test.ts`                                                                                    | PASS; real stalled TCP peer, safe 503, liveness healthy                                                                                 |
| `corepack pnpm install --frozen-lockfile`                                                                                                                                                    | PASS on Windows and fresh Linux; no lock drift                                                                                          |
| `corepack pnpm verify`                                                                                                                                                                       | PASS Windows and fresh Linux; toolchain, format, lint, strict types, architecture, secrets, licenses, 33 unit tests, 5 workspace builds |
| Windows integration with JSON reporter                                                                                                                                                       | PASS 7, skipped 2; [local report](../../../artifacts/windows-integration.json) is ignored and retained only on this workstation         |
| Linux integration with JSON reporter                                                                                                                                                         | PASS 9, skipped 0; [local report](../../../artifacts/linux-integration.json)                                                            |
| `corepack pnpm test:unit --coverage --reporter=default --reporter=json --outputFile=artifacts/windows-unit.json`                                                                             | PASS 33; Linux equivalent also PASS 33                                                                                                  |
| `corepack pnpm db:verify:local` / Linux `corepack pnpm db:verify`                                                                                                                            | PASS all eight invariants; [Linux complete log](../../../artifacts/linux-final.log)                                                     |
| Trivy fs, vuln/secret/misconfig, HIGH/CRITICAL, include-dev-deps                                                                                                                             | PASS exit 0; [local JSON](../../../artifacts/trivy-repository-final.json)                                                               |
| Trivy image via exported tar; unchanged image                                                                                                                                                | 0 High, 0 Critical, 0 secrets; [local JSON](../../../artifacts/trivy-postgis-final.json)                                                |

Local artifact links are not hosted CI links. Their hashes, counts, image identity, and clean-run
details are retained in the versionable, sanitized
[verification record](evidence/implementation-verification.json). Raw reports/logs remain ignored.

The Linux environment copied only the source snapshot, initialized a disposable Git repository for
the secret scanner, installed Git as a prerequisite, ran the commands above with `CI=true`, and used
an isolated temporary database network. A public TLS inspection CA was mounted for this environment
only. Neither that CA nor a host-specific path is required by project configuration.

The smoke measurement used the compiled API with five warmup requests and 50 liveness injections:
p50 0.1377 ms, p95 0.3014 ms, max 1.1601 ms. This measures the in-process Fastify path on Windows,
not network latency, load capacity, or a production performance target. Two preliminary one-line
measurement attempts failed at shell quoting/module interop before application startup; the compiled
CommonJS invocation supplied the recorded measurement.

### Final dependency and image inventory

| Area           | Exact versions                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain      | Node 22.14.0; pnpm 11.25.0; TypeScript 6.0.3; Turbo 2.10.12                                                                           |
| Quality        | ESLint/@eslint/js 10.9.1/10.0.1; typescript-eslint 8.69.0; Prettier 3.9.6                                                             |
| Tests          | Vitest and coverage-v8 4.1.1; Vite 7.3.6; tsx 4.23.13                                                                                 |
| Types          | @types/node 22.20.1; @types/pg 8.23.1                                                                                                 |
| API/worker     | Nest common/core/platform-fastify 12.0.1; Fastify 5.12.1; CORS 11.3.0; Helmet 13.1.1; reflect-metadata 0.2.2; RxJS 7.8.2              |
| Data/config    | pg 8.23.0; Kysely 0.29.5; Zod 4.5.4                                                                                                   |
| Observability  | Pino 10.3.1; pino-pretty 13.1.3; UUID 11.1.0; OTel API 1.9.1, exporter 0.222.0, SDK/resources 2.11.0, semantic conventions 1.43.0     |
| Database image | PostgreSQL 17.11 / PostGIS 3.5.7; pinned upstream Alpine digest in Dockerfile; libexpat 2.8.4-r0; su-exec 0.3-r0; final UID/GID 70:70 |
| Scanner        | Trivy 0.70.0; DB updated 2026-09-04T19:03:14Z                                                                                         |

Lockfile SHA-256: `0c23466cc24c9a04afa5a8c09a065fb648cd0c6ab7772004dfed870cceef3071`.
Final database image ID:
`sha256:acd4e2b0d36c026955274ced62e2db4dd6d0387506d1b760a1b141051162e5d7`.
License policy inspected 322 installed packages on Windows and 266 platform-selected packages on
fresh Linux, with zero findings. This is metadata policy validation, not a legal license opinion.

### Files and decisions delivered

- Root repository/toolchain/editor/ignore files, package/workspace/lock manifests, TypeScript,
  Turbo, ESLint, Prettier, Vitest, README, CONTRIBUTING, and SECURITY.
- `apps/api`: bootstrap, health/probe/lifecycle, safe errors and logging adapter, runtime entry point,
  and unit/integration tests. `apps/worker`: lifecycle shell, bootstrap, entry point, tests.
- `packages/config`, `packages/observability`, `packages/test-support`: narrow foundation code and
  its tests/invalid-boundary fixture. No business modules or contracts placeholder was added.
- `infra/database`: hardened image, bootstrap grants, paired SQL migration and failure fixture;
  `infra/local/compose.yaml`. `scripts`: toolchain, architecture, secret/license checks, environment
  generator, migrations/verification, compiled process lifecycle tests.
- `.github/workflows/phase-00.yml`; ADRs 001–010; architecture/setup/configuration/database/testing/
  security/observability/operations references; this implementation report and sanitized evidence.
- Closing continuation modified only the shutdown test, README, CONTRIBUTING, testing guide,
  workflow, and this report; added the stalled-readiness test and sanitized evidence. The previous
  timeout expectation was already correct on disk. No image, lockfile, or runtime behavior changed.

The Turborepo skill used earlier informed explicit upstream build dependencies and declared outputs.
No additional skill was needed for this final test/documentation continuation.

## Deviations and limitations

- No departure from Phase 0 product scope has been authorized or introduced.
- Repository license (`UNLICENSED` pending decision), remote ownership identities, and enforceable
  branch protections require stakeholder input. PLAN Section 17 calls these closure decisions;
  they are not silently waived or treated as production-ready.
- No commits or remote exist. There is no committed lockfile/checkout or hosted CI run to certify.
  Clean Linux verification used Debian bookworm, while the configured hosted runner is ubuntu-24.04.
- CI dependency caching is not configured yet; frozen installation is verified without cache.
  No OpenAPI drift check applies because no generated public product contract exists.
- The earlier automatic approval review rejected local `pnpm audit` because it sends dependency
  metadata to the npm advisory service. No bypass was attempted. Local Trivy lockfile scanning,
  including development dependencies, supplies local vulnerability evidence; the npm audit CI job
  remains configured but unexecuted. A Docker-socket mount was also rejected earlier; image analysis
  used a tar export instead.
- Trivy reported no High/Critical findings but warned that Alpine 3.24 is absent from its embedded
  EOL table and that CVE-2026-80256 lacks vulnerability details. Record these scanner limitations;
  zero reported findings does not establish absence of unknown vulnerabilities.
- Windows cannot exercise POSIX child signals; both compiled signal tests passed in clean Linux.
  The shutdown coordinator test proves its waiting bound; process tests separately prove actual exit.
- The TLS inspection CA and Git ownership exception were process-local environmental accommodations.
  TLS stayed validated, `strictSsl: true` remains, and no global Git setting or PATH hack was added.
- All generated runtime environment files, outputs, raw scans and dependencies are ignored. Removed
  the three historical image tar exports, two temporary public-CA files, historical scanner outputs,
  and Trivy cache in the validated `.docker-local` directory after preserving the final image scan
  under `artifacts`. The directory no longer exists; removed material can be regenerated. The local
  database and developer environment files were preserved.
- Production hosting/IAM/key custody/backups/operational ownership and all domain features remain
  outside this implementation. No formal adversarial audit or `AUDIT.md` was created.

## Exact acceptance matrix

**Passed: 29 / 36. Failed: 0. Blocked: 7.**

VERIFIED means executed locally or directly inspected. CI-CONFIGURED means the workflow contains the
check, not that GitHub has run it. BLOCKED records the unproved portion of a mandatory criterion.
In particular AC-002 passes the inspected toolchain/check definition; AC-005/028/031 require an
actual hosted outcome and remain blocked. AC-003/004 are literal checkout/committed-lockfile gaps.

| Criterion | Exact PLAN requirement                                                                                                                                                               | Status  | Evidence / blocking reason                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-001    | Git is initialized; default branch and line-ending policy are documented; no generated/secrets files are tracked.                                                                    | PASS    | VERIFIED: Git main, inspected .gitattributes and documented branch policy; index contains no generated or secret files.                                                               |
| AC-002    | Runtime and package-manager versions are pinned; CI verifies them.                                                                                                                   | PASS    | VERIFIED locally: toolchain check confirms Node 22.14.0 / pnpm 11.25.0. CI-CONFIGURED: quality job invokes this check; no hosted success is claimed.                                  |
| AC-003    | A clean checkout follows the documented setup without undocumented global tools other than Git, container runtime, and pinned Node/package manager bootstrap.                        | BLOCKED | BLOCKED: source snapshot installs and verifies cleanly in Linux, but no committed checkout exists yet. README/LOCAL_SETUP commands inspected.                                         |
| AC-004    | Frozen install succeeds from the committed lockfile.                                                                                                                                 | BLOCKED | BLOCKED: frozen install passed on Windows and empty Linux store, but pnpm-lock.yaml remains untracked, not committed as the criterion literally requires.                             |
| AC-005    | A single documented root verification command completes locally and in CI.                                                                                                           | BLOCKED | BLOCKED: exact root verify passes Windows and clean Linux; execution in hosted CI remains pending.                                                                                    |
| AC-006    | Workspace contains only justified Phase 0 apps/packages; no functional domain placeholder exists.                                                                                    | PASS    | VERIFIED: architecture check permits only API, worker, config, observability, test-support; source/SQL inventory has no functional domain placeholder.                                |
| AC-007    | Strict typecheck, lint, format check, and build pass with zero errors.                                                                                                               | PASS    | VERIFIED: final root verify passed format, lint, strict typecheck and all five builds on Windows and clean Linux.                                                                     |
| AC-008    | Automated boundary checks pass and a test/fixture proves a forbidden dependency is detected.                                                                                         | PASS    | VERIFIED: architecture check and two unit tests pass, including forbidden-dependency fixture rejection.                                                                               |
| AC-009    | Direct environment access is confined to the configuration composition boundary.                                                                                                     | PASS    | VERIFIED: AST boundary check and source search restrict actual process.env reads to packages/config/src/environment.ts.                                                               |
| AC-010    | Required ADR-001 through ADR-010 are accepted and consistent with code, or the phase fails.                                                                                          | PASS    | VERIFIED: ADR-001–010 reread; accepted decisions match scoped code, pinned toolchain and hardened DB design.                                                                          |
| AC-011    | Missing/malformed critical configuration causes fail-fast startup with no secret value printed.                                                                                      | PASS    | VERIFIED: configuration unit tests reject absent/malformed fields without printing secret canaries; API/worker entrypoints load config before initialization.                         |
| AC-012    | Production-unsafe defaults, wildcard credentialed CORS, or example secrets are rejected.                                                                                             | PASS    | VERIFIED: production placeholder/insecure-origin/implicit-host and wildcard-CORS rejection tests pass.                                                                                |
| AC-013    | Repository secret scan passes; `.env.example` contains no usable credential.                                                                                                         | PASS    | VERIFIED: repository/history secret check passes; inspected .env.example placeholders and ignore rules; final Trivy secret scan reports zero.                                         |
| AC-014    | Recursive redaction tests pass for the documented corpus, nested data, arrays, mixed case, error objects, headers, and URLs.                                                         | PASS    | VERIFIED: recursive redaction unit tests and final logger/request-logging tests pass across documented keys, arrays, mixed case, errors and URLs.                                     |
| AC-015    | Unexpected API errors return a stable safe envelope with request ID and no stack/query/path/input leak.                                                                              | PASS    | VERIFIED: Problem Details and safe exception-filter tests pass; real timeout returns SERVICE_UNAVAILABLE with effective request ID and no route/internal error.                       |
| AC-016    | Dependency/container scans contain no unresolved exploitable Critical or High issue; any non-exploitable exception has external stakeholder acceptance, owner, evidence, and expiry. | PASS    | VERIFIED: Trivy repository including dev dependencies and unchanged PostGIS image report zero High/Critical findings; scan hashes/warnings retained. No risk exception self-approved. |
| AC-017    | A pinned PostgreSQL/PostGIS local service becomes healthy through documented commands.                                                                                               | PASS    | VERIFIED: pinned hardened PostGIS service is healthy; final image config is USER=70:70; fresh DB container started in final Linux run.                                                |
| AC-018    | All migrations apply to an empty disposable database and a second run is a no-op.                                                                                                    | PASS    | VERIFIED: database verification returns cleanApply=true and repeatNoOp=true on disposable PostgreSQL databases.                                                                       |
| AC-019    | Migration rollback/roll-forward, failure, and concurrent-run behaviors match the documented strategy and have automated evidence.                                                    | PASS    | VERIFIED: rollbackRollForward, invalidMigrationRolledBack and concurrentSerialized all true in Windows and Linux DB matrix.                                                           |
| AC-020    | The runtime path cannot perform schema DDL under the production role design; this is tested where feasible and otherwise demonstrated by reviewed grants script.                     | PASS    | VERIFIED: runtimeDdlDenied=true under SET LOCAL ROLE trayvi_runtime; bootstrap and migration grants inspected.                                                                        |
| AC-021    | No product/domain table or Villa Altagracia hardcoding exists.                                                                                                                       | PASS    | VERIFIED: source/SQL search found only migration metadata and platform.outbox_events; geography absent from runtime. Test-only DDL is isolated and rolled back.                       |
| AC-022    | API and worker start with structured logs and stop gracefully within the configured bound.                                                                                           | PASS    | VERIFIED: compiled API and worker start -> SIGTERM -> stop pass in final Linux integration, exit 0 within bound; Windows close/drain tests pass.                                      |
| AC-023    | Liveness succeeds without querying dependencies; readiness becomes non-ready when DB is unavailable and recovers when restored.                                                      | PASS    | VERIFIED: real database removal/restoration changes readiness 200 -> 503 -> 200; liveness works with unavailable/stalled DB.                                                          |
| AC-024    | Health/error responses do not expose secrets, topology, dependency exception text, or configuration.                                                                                 | PASS    | VERIFIED: health/error projections assert fixed safe bodies and no DB endpoint/exception detail; safe exception canary tests pass.                                                    |
| AC-025    | Valid request/correlation IDs propagate; malformed/oversized/control-character values are replaced safely; response contains the effective request ID.                               | PASS    | VERIFIED: request-context unit, API header and request-log integration tests pass; malformed/oversized/control characters replaced, effective IDs returned.                           |
| AC-026    | Metrics/traces/logs use documented low-risk fields; telemetry exporter failure is bounded and does not crash or leak payloads.                                                       | PASS    | VERIFIED: low-cardinality fields inspected; rejected and hanging telemetry-provider tests pass with bounded safe failure logs.                                                        |
| AC-027    | Request body size, server/request timeout, readiness timeout, and graceful-shutdown limits are explicit and tested.                                                                  | PASS    | VERIFIED: body/header/URL rejection; real handler timeout; stalled-peer readiness deadline; fake-clock and real-clock shutdown deadline tests; compiled POSIX exit tests pass.        |
| AC-028    | Unit and integration suites pass on the supported Windows developer path and selected Linux CI runner.                                                                               | BLOCKED | BLOCKED: Windows 33 unit + 7 integration (2 POSIX skipped), clean Debian Linux 33 + 9 (0 skipped). Selected hosted ubuntu-24.04 runner has not executed.                              |
| AC-029    | Integration tests execute against real PostgreSQL/PostGIS and are isolated/repeatable.                                                                                               | PASS    | VERIFIED: isolated disposable PostgreSQL/PostGIS tests pass repeatedly and clean up their databases; final Linux container used fresh storage.                                        |
| AC-030    | Failure-path tests cover invalid config, DB loss, telemetry loss, malformed/oversized request, migration failure, and shutdown.                                                      | PASS    | VERIFIED: invalid config, real DB loss, telemetry failure/hang, malformed/oversized input, invalid migration, stalled readiness, handler/shutdown timeout and SIGTERM cases pass.     |
| AC-031    | CI is triggered for pull requests and protected-branch changes, uses least permissions/timeouts, and all required jobs pass.                                                         | BLOCKED | BLOCKED: CI-CONFIGURED PR/main triggers, contents:read, timeouts, required summary gate and evidence upload. No remote/all-jobs-passing or protected-branch evidence exists.          |
| AC-032    | Test, scan, migration, and build evidence is retained as links/artifacts in `IMPLEMENTATION.md` or the CI run.                                                                       | PASS    | VERIFIED: sanitized versionable JSON retains results, artifact hashes and links to ignored local raw reports/log; CI artifact upload is configured, not claimed executed.             |
| AC-033    | README/setup, architecture, config, migration, test, security, observability, and operations documentation match actual commands/behavior.                                           | PASS    | VERIFIED: README/setup, architecture, config, migrations, testing, security, observability and operations references inspected; verification/coverage instructions updated.           |
| AC-034    | Phase 0 implementation report maps AC-001–AC-033 to concrete evidence.                                                                                                               | PASS    | VERIFIED: this report maps each exact AC-001–AC-033 to specific executed or inspected evidence and labels external gaps.                                                              |
| AC-035    | An adversarial audit is completed using Section 15, every finding is recorded, and all Critical/High findings are remediated and retested.                                           | BLOCKED | BLOCKED by current scope: formal independent adversarial audit explicitly deferred by user; implementation self-checks are not that audit.                                            |
| AC-036    | `AUDIT.md` reports final counts, residual risks, evidence, and `PASS`; otherwise Phase 0 is not complete.                                                                            | BLOCKED | BLOCKED by current scope: AUDIT.md deliberately absent; no audit PASS has been fabricated.                                                                                            |

## Final implementation decision

Final Git review: branch `main`, no commit, no remote, no tracked files; source and documentation
remain untracked. Both diffs and `diff --check` are empty because there is no indexed baseline.
The untracked candidate inventory contains no certificate, tar export, runtime environment file,
scan output, dependency directory or build output. `.env.api/.env.worker/.env.local`, dependencies,
builds, coverage and raw evidence are explicitly ignored. No unrelated container was changed.

**NOT READY FOR PHASE 0 AUDIT**

All executed tests and code quality checks pass. The remaining blockers are the missing committed
checkpoint/checkout, hosted CI execution on the selected runner, and stakeholder repository ownership,
license and branch-protection decisions. AC-035/036 belong to the explicitly deferred audit and are
not implementation failures; their absence alone is not used to invent permission to begin that audit.
No Phase 1 work has started.

## Repository closure — first committed reproduction

The sections and 29/36 matrix above preserve the pre-checkpoint implementation history. This
closure task does not perform the formal audit. Its current status is recorded in the subsequent
closure summary once the committed reproduction finishes.

Initial checkpoint: `e9f156fcbda8226b9d6c1d1bc6903fe21cd48c49`;
tree: `4d440498486d41cc00555bad1cbba2fdf0140973`. It contains 151 reviewed versionable files:
the original 149 plus LICENSE.md and repository governance. No environment, certificate, private key,
dependency directory, temporary scan/export or build was staged. Brand PNGs are intentional delivery
assets. The developer-specific path in PROJECT_OVERVIEW.md was removed; test-only synthetic path
canaries remain intentional. Markdown hard breaks are recognized by `.gitattributes`; four preexisting
SQL EOF blank-line warnings are retained to avoid changing migration bytes/checksums merely for style.

The first real checkout used a verified Git bundle and `git clone` in a fresh Debian 12 container,
with an empty dependency store and no shared workspace node_modules. Frozen install, matching
lockfile hashes, quality gate and 33 unit tests passed. Integration returned **8 passed, 1 failed**:
the compiled worker exited with code 0 without the expected stopped log. The standalone DB matrix
was not reached. This attempt is not a successful clean-checkout gate.

Preserved attempt evidence (ignored raw files):

- `artifacts/closure-linux.log`, SHA-256
  `5bd0f5133a5269ae2437fa25fa2b6ce8afe0c1ab1c93dfa1124f9690beaa3a85`;
- `artifacts/closure-linux-integration.json`, SHA-256
  `c95c262172686be196441d8724add6c36fc45abdb72d1c668e4673ce2534ec50`.

The no-queue worker had no referenced event-loop resource and could exit naturally while the test
raced startup with SIGTERM. The correction keeps only the standalone process alive with a no-work
idle timer, clears it during bounded shutdown, and announces process readiness after signal handlers
are installed. API startup announcement likewise follows handler registration. The regression test
uses that event-driven readiness boundary, sends real SIGTERM without an arbitrary sleep, waits for
process `close` (including drained output pipes), and cleans up on failure. This uses Node's documented
[timer lifecycle](https://nodejs.org/download/release/v22.14.0/docs/api/timers.html#class-timeout) and
[child-process close semantics](https://nodejs.org/download/release/v22.14.0/docs/api/child_process.html#event-close).
It adds no product work, queue or outbox consumer. A new committed checkout must pass before AC-003
and runtime acceptance can be considered verified at the corrected checkpoint.

## Repository and hosted CI closure — final implementation record

This section supersedes the closure status statements above without deleting them: those statements
remain the chronological record of the uncommitted implementation and first failed checkout. This is
still implementation verification, not the adversarial audit required by AC-035/036.

### Worker regression and committed lineage

The defect was reproduced naturally from historical commit
`e9f156fcbda8226b9d6c1d1bc6903fe21cd48c49` (tree
`4d440498486d41cc00555bad1cbba2fdf0140973`). The process emitted `worker.started`, then exited 0
before the harness could deliver shutdown; `worker.stopped` was absent. Evidence is preserved in
`artifacts/worker-original-reproduction.log` (SHA-256
`4c2f41405407cda1529fb1804d3425314d66d347c03e02687adbae5b5d9dca9f`).

The root cause combined lifecycle ordering and premature process termination. The no-queue worker had
no referenced event-loop handle, and its bootstrap emitted startup before the entrypoint installed its
signal handlers. The process could therefore terminate naturally while the integration harness raced
to send SIGTERM. Waiting for child `exit` could also precede delivery of the final pipe data.

Commit `c12a6f3ad8492e6a03ce3b2cf576e15a1ebe1743` (tree
`20c174b12b6292068f10cbd1cd0ff76a81eb36b7`, parent `e9f156f`) fixes that boundary. A referenced
no-work timer holds only the standalone worker open, signal handlers are installed before
`worker.process.ready`, bounded close clears the timer, and the harness waits for child `close`. The
regression sends real SIGTERM without an arbitrary sleep and asserts ordered `worker.started`,
`worker.draining`, SIGTERM, `worker.stopped`, exit 0, and no timeout. Corrected Linux evidence:
`artifacts/worker-fix-linux-success.log` SHA-256
`64c1d3bdc2310523a08b9fa4630ee8a1311e2b26fccba6143c7de86ef769d49d` and JSON SHA-256
`285c391a0b0d23cab08e281facfc72838acb606b459e79717711d903d00aea6f`.

No checkpoint was amended and no history was rewritten. `.github/CODEOWNERS` contains exactly
`* @SaulL08`. Normal pushes created private `SaulL08/Trayvi` on `main`; no force option was used.

### Clean checkout of the corrected security checkpoint

The first hosted run, `33994970416` on worker-fix commit `c12a6f3`, retained all three artifacts but
failed its security gate. Its real image scan found seven HIGH and zero Critical findings in Alpine
`libuuid 2.42.1-r0`, all with a fixed package available. This was classified as a project image defect,
not hidden as CI/tool failure. Commit `291550846f70f8cafdc521db92a456150d20c7b6` (tree
`f4d7bc2f3dbd38028c61159ebe00cce621d1e11e`, parent `c12a6f3`) pins `libuuid 2.42.3-r1` in the
hardened PostGIS image. An earlier build requesting repository-obsolete `2.42.3-r0` remains preserved
in `artifacts/postgis-libuuid-build.log`; the successful build and zero-High/Critical scan are preserved
in `artifacts/postgis-libuuid-build-success.log` and `artifacts/trivy-postgis-libuuid-fixed.json`.

A new Git bundle was cloned at exact commit `2915508` into a fresh Debian 12 container with no shared
checkout, dependencies or environment files. Node 22.14.0 and pnpm 11.25.0 performed a frozen install;
the committed lockfile SHA-256 remained
`0c23466cc24c9a04afa5a8c09a065fb648cd0c6ab7772004dfed870cceef3071` before and after. Format,
lint, strict typecheck, architecture, secrets, licenses, 33/33 unit tests, all five builds, 9/9 Linux
integrations, compiled API/worker SIGTERM lifecycles and all eight database/PostGIS invariants passed.
The verified clone ended clean. Raw evidence and hashes are recorded in
`evidence/implementation-verification.json`; the aggregate log SHA-256 is
`e8c561522f9042e82d9647929d1f7dd2e0117664ea0736ce44a84e72d8459689`.

### Hosted CI, security and retained artifacts

[Hosted run 33995414066](https://github.com/SaulL08/Trayvi/actions/runs/33995414066) executed exact
commit `291550846f70f8cafdc521db92a456150d20c7b6` on the `ubuntu-24.04` label and concluded success.
All four jobs passed: static/unit/build (`101384997696`), PostgreSQL/PostGIS/process integration
(`101384997670`), dependency/secret/filesystem/image scans (`101384997445`), and the aggregate
`Phase 0 required gate` (`101385207947`). This proves the workflow rather than merely inspecting YAML.

The hosted evidence reports 33 unit and 9 integration tests; 73.35% line, 62.38% branch, 78.2%
function and 72.82% statement coverage; eight database invariants; zero filesystem High/Critical;
zero PostGIS image High/Critical; zero repository secrets; 266 licenses checked with zero findings;
and one moderate dependency advisory, below the mandatory High/Critical threshold. A second Trivy
0.70 scan of the downloaded artifacts found zero secrets. Known non-blocking warnings are retained:
Alpine 3.24 is not yet in Trivy's EOL table; one CVE lacked scanner detail; and GitHub forced
SHA-pinned actions targeting Node 20 to execute on Node 24. These do not convert a known finding into
an exception or claim absence of unknown vulnerabilities.

| Artifact ID | Name                   | Retained until (UTC) | Verified content                                        |
| ----------- | ---------------------- | -------------------- | ------------------------------------------------------- |
| 9977915657  | `phase-00-quality`     | 2026-09-19 22:17:35  | unit JSON, quality log, coverage summary, LCOV and HTML |
| 9977913749  | `phase-00-integration` | 2026-09-19 22:17:27  | integration JSON/log and eight-invariant DB log         |
| 9977911721  | `phase-00-security`    | 2026-09-19 22:17:18  | dependency, secret, license, filesystem and image scans |

### Branch protection attempt

After the green run, the API was asked to require `Phase 0 required gate`, strict up-to-date status,
linear history and conversation resolution, with admin enforcement and force-push/deletion disabled.
GitHub returned HTTP 403: `Upgrade to GitHub Pro or make this repository public to enable this
feature.` A follow-up branch query reports `protected: false`. Repository visibility was not changed.
The exact implementation status is **BLOCKED_BY_REPOSITORY_PERMISSION**. This prevents AC-031 from
passing even though every hosted job is green.

### Current acceptance matrix

This is the authoritative implementation-closure classification: **33 PASS, 0 FAIL, 1 BLOCKED,
2 PENDING AUDIT**. The earlier 29/36 table is preserved as historical evidence.

| Criterion | Status        | Current evidence                                                                                                                          |
| --------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AC-001    | PASS          | `main` is committed and published; line-ending policy is tracked; generated/secrets inventory is clean.                                   |
| AC-002    | PASS          | Node 22.14.0 and pnpm 11.25.0 are pinned and verified locally and in hosted CI.                                                           |
| AC-003    | PASS          | A fresh Debian 12 clone of exact commit `2915508` completed the documented setup and remained clean.                                      |
| AC-004    | PASS          | Frozen installs succeeded from the committed lockfile locally and hosted; its hash was unchanged.                                         |
| AC-005    | PASS          | The documented root verification command passed locally, in the clean clone and hosted CI.                                                |
| AC-006    | PASS          | Only the Phase 0 API, worker and justified shared packages exist; no functional domain placeholder was added.                             |
| AC-007    | PASS          | Format, lint, strict typecheck and all builds passed with zero errors.                                                                    |
| AC-008    | PASS          | Boundary checks and their forbidden-dependency regression passed.                                                                         |
| AC-009    | PASS          | Environment access remains confined to the configuration composition boundary.                                                            |
| AC-010    | PASS          | ADR-001–ADR-010 remain accepted and consistent with the implemented foundation.                                                           |
| AC-011    | PASS          | Invalid critical configuration fails safely before initialization without secret values.                                                  |
| AC-012    | PASS          | Unsafe production defaults and wildcard credentialed CORS remain rejected by tests.                                                       |
| AC-013    | PASS          | Repository and downloaded-artifact secret scans found zero secrets; examples contain placeholders only.                                   |
| AC-014    | PASS          | Recursive redaction corpus tests passed.                                                                                                  |
| AC-015    | PASS          | Unexpected API errors retain the safe request-ID envelope without internal data.                                                          |
| AC-016    | PASS          | Corrected repository/image scans contain zero known High/Critical issues; no exception was self-approved.                                 |
| AC-017    | PASS          | The pinned PostGIS service became healthy as non-root `70:70`.                                                                            |
| AC-018    | PASS          | Empty-database migration and repeat no-op are true in clean and hosted matrices.                                                          |
| AC-019    | PASS          | Rollback/roll-forward, invalid migration rollback and concurrent serialization are true.                                                  |
| AC-020    | PASS          | The runtime role was denied schema DDL in the real database test.                                                                         |
| AC-021    | PASS          | No product/domain table or Villa Altagracia runtime hardcoding exists.                                                                    |
| AC-022    | PASS          | Compiled API and worker start, receive real SIGTERM, drain, log stop and exit 0 within bounds.                                            |
| AC-023    | PASS          | Liveness independence and readiness loss/recovery against real PostgreSQL passed.                                                         |
| AC-024    | PASS          | Health/error responses expose no secret, topology or dependency detail.                                                                   |
| AC-025    | PASS          | Request/correlation ID validation and propagation tests passed.                                                                           |
| AC-026    | PASS          | Low-risk telemetry and bounded exporter failure/hang tests passed.                                                                        |
| AC-027    | PASS          | Body/header/URL/request/readiness/shutdown limits are explicit and tested.                                                                |
| AC-028    | PASS          | Windows developer suites and all Linux suites passed; hosted `ubuntu-24.04` executed successfully.                                        |
| AC-029    | PASS          | Hosted and clean-clone integration used isolated real PostgreSQL/PostGIS and passed repeatably.                                           |
| AC-030    | PASS          | Required configuration, DB, telemetry, input, migration, timeout and shutdown failure paths passed.                                       |
| AC-031    | BLOCKED       | Hosted triggers, permissions, timeouts and aggregate gate work, but `main` protection is unavailable: `BLOCKED_BY_REPOSITORY_PERMISSION`. |
| AC-032    | PASS          | Three downloadable hosted artifacts retain tests, coverage, DB, build and security evidence for 14 days.                                  |
| AC-033    | PASS          | Setup, architecture, config, migration, testing, security, observability and operations docs match behavior.                              |
| AC-034    | PASS          | Historical and current matrices map AC-001–AC-033 to executed or inspected evidence.                                                      |
| AC-035    | PENDING AUDIT | The formal Section 15 adversarial audit is intentionally outside this closure task.                                                       |
| AC-036    | PENDING AUDIT | `AUDIT.md` and the audit verdict are intentionally not created or fabricated.                                                             |

## Repository closure decision

**NOT READY FOR PHASE 0 AUDIT**

The code, clean checkout, security correction, remote, artifacts and hosted CI are closed. The sole
pre-audit blocker is AC-031: GitHub refuses branch protection for this private repository on the
current plan. Upgrade the repository owner to a plan that supports protection (or explicitly choose
public visibility), then apply and verify the documented protection request. No Phase 1 work or formal
Phase 0 audit has started.

## AC-031 governance retry — 2026-09-06

This section is the current governance closure record. It preserves the earlier implementation,
repository closure, HTTP 403 and acceptance evidence above. Scope is AC-031 only.

At `2026-09-06T02:55:54.7421027Z` (`2026-09-05` in America/Santo_Domingo), the authenticated
GitHub account was `SaulL08`, with repository administrator permission. Local `HEAD`, local
`origin/main`, `git ls-remote` and GitHub's branch API agreed on
`51f4929edcbd129ad650348a7ed4fe887153fcb9`. The working tree was clean. The repository remains
private at `https://github.com/SaulL08/Trayvi.git`; branch is `main`, CODEOWNER is `@SaulL08`.
Initial sandbox credential failures were resolved by accessing the Windows credential store outside
the sandbox; the protection failure below occurred after successful authentication.

### Published check and preserved hosted CI

[Run 33995808121](https://github.com/SaulL08/Trayvi/actions/runs/33995808121) was queried again:
commit `51f4929edcbd129ad650348a7ed4fe887153fcb9`, status `completed`, conclusion `success`,
runner label `ubuntu-24.04`. Security (`101386033653`), quality (`101386033699`), integration
(`101386033728`) and required gate (`101386271382`) all concluded `success`. The check-run API
confirmed the exact name `Phase 0 required gate`, app ID `15368`, app slug `github-actions`.
The earlier runs and all baseline, worker-fix and security-fix evidence remain preserved.

### Requested protection and effective API result

The authenticated `PUT /repos/SaulL08/Trayvi/branches/main/protection` requested the published
check bound to GitHub Actions, strict up-to-date checks, administrator enforcement, linear history,
conversation resolution, and disabled force pushes and deletion. Review requirements and actor
restrictions were `null`; no extra reviewer, signed-commit, deployment or team requirement was added.

- **First attempt:** HTTP 403 due to the repository plan limitation, preserved above.
- **Final attempt in this retry:** HTTP 403 again; protection was **not enabled**. Exact message:
  `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- A subsequent independent `GET /repos/SaulL08/Trayvi/branches/main` returned `protected: false`,
  `protection.enabled: false`, `enforcement_level: "off"`, `contexts: []`, `checks: []`.
- `GET /repos/SaulL08/Trayvi/branches/main/protection` returned the same HTTP 403. Ruleset and
  effective branch-rule queries also returned HTTP 403 with the same plan limitation.
- Strict, admin enforcement, linear history, force-push and deletion settings cannot be reported as
  effective values: the protection endpoint did not return them. Requested values are not evidence
  of enforcement. The authenticated user API did not expose a plan name.

No destructive negative test was appropriate: the branch API already proves protection is inactive.
No force push, branch deletion, visibility change, protection bypass or history rewrite was performed.
The exact request and response evidence is in `evidence/implementation-verification.json` under
`governanceClosureRetry`. Documentation is published with a new normal commit and normal push;
post-push HEAD, CI and protection are checked again and reported at handoff.

### Current acceptance and decision

The previous 33 passing criteria retain their accepted evidence. **33 PASS, 0 FAIL, 1 BLOCKED,
2 PENDING AUDIT**:

| Criterion | Status        | Evidence                                                                |
| --------- | ------------- | ----------------------------------------------------------------------- |
| AC-031    | BLOCKED       | Authenticated protection PUT returned HTTP 403; GET protected is false. |
| AC-035    | PENDING AUDIT | Formal adversarial audit has not started.                               |
| AC-036    | PENDING AUDIT | No audit report or verdict has been created.                            |

**NOT READY FOR PHASE 0 AUDIT**. The externally reported resolution is not reflected by GitHub's
effective API behavior for this private repository. AC-031 requires successful protection enablement
and independent read-back after GitHub grants the capability to the repository owner. No Phase 1
work or implementation revalidation was performed in this retry.
