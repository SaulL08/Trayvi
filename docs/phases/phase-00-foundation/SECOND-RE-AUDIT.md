# Phase 0 — Second Independent Adversarial Re-Audit

**Decision:** PHASE 0 SECOND RE-AUDIT — FAIL  
**Date:** 2026-09-08  
**Audited commit:** `ef6ed76b16394bbacf9e34337bf0be5aae4a4a17`  
**Audited tree:** `0d7acb0361ef6755b59ae80775a836a28b8d6cf9`  
**Branch:** `main`  
**Remote:** `https://github.com/SaulL08/Trayvi.git`  
**Scope:** Phase 0 second re-audit only; Phase 1 remains unauthorized

## Target and historical integrity

Before substantive work, local `HEAD`, local `origin/main`, and authenticated GitHub `main` all
resolved to the authorized commit. Its tree matched the authorized tree and the worktree was clean.
The target stayed fixed throughout discovery. At resumption, the only worktree change was this
untracked audit report.

The historical records were hash-checked and not edited:

| Record             | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `AUDIT.md`         | `3EF87D28459B5B5F608CBC202253EACF0F2D27F84E6EC6354601AF7A292F22F1` |
| `REMEDIATION.md`   | `BC1E7A9AEBCC70DA2159A051BB277B7A05531FD19886A5B2A719C6F954BB00A2` |
| `RE-AUDIT.md`      | `B1BD26F64A4DBBB584C6ED29A2DF42C465618C634E4965AEA85449256320B328` |
| `REMEDIATION-2.md` | `1DFA947E520CD024BACC7FFDBB836AEDE1EF1FE347D43B3154B522B15BE80BD8` |

## Environment and method

- Node `v22.14.0`, pnpm `11.25.0`, Windows developer path, Docker Engine `29.7.2`, a disposable
  `trayvi/postgis:phase-00-fixed` container, and an isolated
  `node:22.14.0-bookworm-slim` POSIX probe were used.
- An authenticated GitHub CLI session was used only to read branch, governance, runs, logs, jobs,
  and artifacts.
- A no-hardlink isolated checkout matched the target commit/tree. Its dependency tree, build output,
  and test output were newly created; pnpm reused only its content-addressable package cache.
- The Phase 0 plan, implementation and audit/remediation chain, ADRs, security/threat model,
  workflow, retained evidence, manifests, lockfile, sources, tests, database bootstrap/migrations,
  and operational documentation were reviewed.
- Key implementation files included `packages/config/src/parse-config.ts`, observability logger,
  redactor, telemetry and shutdown sources, API/worker bootstrap and entry points, architecture and
  security scripts, migration runner/verification, migrations `0001`–`0003`, and
  `.github/workflows/phase-00.yml`.
- Temporary harnesses used synthetic values and retained only boolean/count evidence. No product,
  remediation, workflow, or historical evidence file was changed.

## Original findings status

The variants below are counted as reopenings when they exercise the same original root cause or
trust boundary. They are not duplicated as new findings.

| ID           | Original severity | Status   | Independent evidence                                                                                        |
| ------------ | ----------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| P0-AUD-001   | HIGH              | REOPENED | Eleven sensitive aliases/text/error variants crossed the real final Pino boundary without redaction.        |
| P0-AUD-002   | HIGH              | CLOSED   | Admission stop, active-operation drain, deadline failure, truthful status, and no false stop log passed.    |
| P0-AUD-003   | HIGH              | CLOSED   | Exact migration prefix/pairs/checksums, failure rollback, no-op, down/up, and concurrent locking passed.    |
| P0-AUD-004   | MEDIUM            | REOPENED | Compiling reflective env access and a static-variable dynamic import produced zero architecture violations. |
| P0-AUD-005   | MEDIUM            | CLOSED   | Missing/invalid environment and all attempted production TLS downgrade/conflict forms failed closed.        |
| P0-AUD-006   | MEDIUM            | CLOSED   | The physical runtime login remained restricted and could not regain admin, role, DDL, or extension powers.  |
| P0-AUD-007   | MEDIUM            | REOPENED | Runtime could rewrite event identity/payload and claim metadata while retaining a valid status shape.       |
| P0-AUD-008   | MEDIUM            | CLOSED   | Descriptor traversal avoided getters and contained proxies, cycles, errors, arrays, and hostile values.     |
| P0-AUD-009   | MEDIUM            | CLOSED   | Concurrent timeout/error/completion paths retained isolated normalized request/correlation IDs.             |
| P0-AUD-010   | MEDIUM            | CLOSED   | Advisory identity/detail was retained and an untriaged Moderate finding failed policy deterministically.    |
| P0-AUD-011   | LOW               | CLOSED   | Repository/reachable history scanning, large streams, history-only findings, and Git failure paths passed.  |
| P0-REAUD-001 | LOW               | REOPENED | Deadline and direct-child escalation worked, but a spawned POSIX descendant survived as an orphan.          |

### P0-AUD-001 — REOPENED: incomplete final logging redaction

The exact prior `password`, encoded-assignment, and PostgreSQL `secretKey` regressions pass. The
central vocabulary still omits `passwd`, generic `credential`, `privateKey`, `sslKey`, and plain
`session`. Equivalent free-form assignments and a synthetic PEM block are also not recognized.

Eleven independent synthetic values were placed in object fields, metadata, text, ordinary errors,
and enumerable error properties. Every value remained in the serialized output of the real
`StructuredLogger`/Pino destination. This reopens the original finding because the same mandatory
last-line sanitizer still permits realistic credentials and private material to reach persistent
logs. Severity remains **HIGH**: the historical artifact proves this class can occur in integration
diagnostics, and successful exploitation can disclose usable authentication or signing material.

Remediation should define canonical sensitive classes and aliases, apply one bounded corpus to keys,
strings, errors, subprocess/integration diagnostics, and final bytes, and add all reproduced forms to
the final-boundary suite. This blocks AC-014, AC-026, AC-033, and AC-035.

### P0-AUD-004 — REOPENED: architecture enforcement remains evasive

A temporary source under `packages/config/src` used `Reflect.get(globalThis, "process")` followed by
`.env`, plus `import(target)` where a constant variable held `@trayvi/api`. The package typecheck
passed and `inspectArchitectureFiles` returned zero violations.

ADR-006 confines process environment access to one file. ADR-019 says equivalent dynamic-import and
environment-access forms are resolved. The plan requires automated direction enforcement without an
exception for statically known variable imports. These probes therefore remain inside the stated
contract. Severity remains **MEDIUM** because this is developer/CI enforcement and requires a code
change, but the green gate can misclassify prohibited coupling and configuration access.

Remediation should resolve statically known import-call arguments, reject unresolved foundation
dynamic imports unless explicitly allowed, and use a semantic lint/TypeScript rule for reflective
environment access. This blocks AC-008, AC-009, AC-033, and AC-035.

### P0-AUD-005 — CLOSED: migration environment and TLS

Seven unsafe cases were rejected: missing or invalid `NODE_ENV`, missing or disabled production TLS,
mixed-case and percent-encoded URL overrides, and an `sslkey` URL override. A valid production
`verify-full` configuration was accepted with certificate verification enabled. The original root
cause is eliminated.

### P0-AUD-007 — REOPENED: outbox evidence remains broadly mutable

Using the physical restricted runtime login against fresh PostgreSQL/PostGIS, direct SQL rewrote an
inserted event's `event_type` and `payload`. After a valid claim, an update that retained
`status='processing'` increased `attempts` by 100 and replaced `locked_by`; PostgreSQL accepted it.

ADR-008 requires the database to permit only its documented state machine, says claims increment
attempts by one and set claim fields, and makes published rows terminal. ADR-019 protects outbox
evidence from destructive runtime access. Table-wide `UPDATE`, a trigger limited to `UPDATE OF
status`, and an unconditional same-status return leave those claims unenforced. Event type/payload
must remain stable after insertion; attempts and lock ownership remain mutable only through defined
claim/lease operations. This is the same integrity and broad-runtime-privilege root cause as
P0-AUD-007, so no duplicate finding is created.

Severity remains **MEDIUM** because Phase 0 has no active consumer or production event data, while
the contract would allow corruption as soon as runtime processing begins. Remediation should separate
producer/worker privileges, replace table-wide UPDATE with explicit column/operation rights, enforce
event identity/content immutability, and define allowed same-state lease mutations. This blocks
AC-033 and AC-035.

### P0-REAUD-001 — REOPENED: timeout leaves a POSIX descendant

Inside Linux Node 22.14.0, `runBoundedProcess` started a signal-resistant child which spawned a
long-lived descendant. At the deadline the helper sent SIGTERM, escalated to SIGKILL for the direct
child, rejected with `SubprocessDeadlineError`, and discarded partial output. The descendant still
responded to PID existence checks because the helper signals only the direct PID. The probe killed
that descendant before its disposable container was removed.

Severity remains **LOW** because scans still fail closed and hosted jobs have outer deadlines, but
the explicit no-orphan requirement and deterministic teardown claim are false. Remediation should
create and terminate a POSIX process group, use a Windows process-tree strategy, wait for tree exit,
and test a resistant parent plus descendant. This blocks AC-035 because a required prior finding is
not fully fixed.

## New findings summary

```text
CRITICAL: 0
HIGH:     0
MEDIUM:   1
LOW:      0
INFO:     0
TOTAL:    1
```

| ID            | Severity | Area                       | Title                                                   | Blocking |
| ------------- | -------- | -------------------------- | ------------------------------------------------------- | -------- |
| P0-REAUD2-001 | MEDIUM   | Repository secret scanning | Project-native credential forms evade both CI detectors | Yes      |

### P0-REAUD2-001 — project-native credential forms evade both CI detectors

- **Affected component:** `scripts/security/scan-secrets.ts`, its unit suite, and the Trivy secret
  policy in `.github/workflows/phase-00.yml`.
- **Violated requirement:** The threat model names repository/CI integrity and database credentials
  as Phase 0 assets and uses repository/history scanning as the baseline control. AC-013 relies on
  that gate as evidence that the repository is free of usable secrets.
- **Reproduction/evidence:** The local detector returned zero findings for four synthetic,
  context-marked cases: a PostgreSQL URL with embedded credential, `password=...`, a generic API-key
  assignment, and an opaque bearer value. Its synthetic private-key header control returned one
  finding. The exact configured Trivy `0.70.0` secret scanner also returned zero results for the four
  missed cases.
- **Impact:** A project-native database credential or explicitly labelled generic credential can be
  committed in the current tree/history while both configured CI layers remain green, shifting
  detection to post-publication review and requiring rotation.
- **Severity rationale:** **MEDIUM**. No actual repository or artifact credential was found, and no
  heuristic detector can identify arbitrary high-entropy strings. The confirmed gap is narrower:
  strong contextual forms used by this project are outside both enforced rule sets.
- **Recommended remediation:** Add repository-specific rules and negative controls for credentialed
  PostgreSQL URLs, password/passwd and API-key assignments, opaque authorization values, private/TLS
  material, and tracked environment files. Keep findings value-free and run the same fixture corpus
  through the custom and hosted scan paths.
- **Blocking status:** AC-013 and AC-035 fail until the promised gate detects the demonstrated
  project-native forms and is retested.

## Controls that resisted

- P0-AUD-002, P0-AUD-003, P0-AUD-005, P0-AUD-006, P0-AUD-008 through P0-AUD-011 remained closed.
- Migration configuration failed closed for missing/invalid environment and TLS downgrade/conflict
  attempts.
- Real PostgreSQL/PostGIS passed all twelve standard migration, privilege, atomicity, state-shape,
  transition, rollback, and concurrency invariants. The broader outbox mutation is separately
  recorded under P0-AUD-007.
- API/worker startup, readiness loss/recovery, normal drain, shutdown timeout truthfulness, and the
  hosted Linux SIGTERM tests passed. The process orphan affects security tooling, not the service
  lifecycle tests.
- Current and reachable-history scans reported zero findings; current hosted artifacts were clean.
  P0-REAUD2-001 concerns demonstrated detector coverage, not a claim that a current secret exists.
- Workflow permissions remain `contents: read`; actions are SHA-pinned; jobs have timeouts; frozen
  install, separate quality/integration/security jobs, artifact retention/cleanup, and the aggregate
  gate are present.

## Verification

| Command/probe                                         | Environment                                | Result                                                                                       |
| ----------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `git clone --no-hardlinks` plus commit/tree read-back | Isolated checkout                          | PASS; exact audited commit and tree.                                                         |
| `corepack pnpm install --frozen-lockfile`             | New checkout, no prior `node_modules`      | PASS; 267 packages; lock policy passed.                                                      |
| `corepack pnpm verify`                                | Node 22.14.0 / pnpm 11.25.0 / Windows      | PASS; format, lint, types, architecture, secrets, 267 licenses, unit tests, and five builds. |
| Unit suite                                            | Clean Windows checkout                     | 69 PASS, 1 POSIX-only SKIP, 70 total across 15 files.                                        |
| Integration suite                                     | Fresh PostGIS / clean Windows checkout     | 17 executable PASS, 2 POSIX-only SKIP, 19 total; seven files passed, one skipped.            |
| Hosted Linux unit/integration                         | GitHub `ubuntu-24.04`                      | 70/70 unit and 19/19 integration PASS with zero skips.                                       |
| `corepack pnpm db:verify`                             | Fresh PostgreSQL 17/PostGIS 3.5            | PASS; 12/12 standard invariants.                                                             |
| Migration configuration matrix                        | Direct parser                              | PASS; seven unsafe cases rejected; valid `verify-full` accepted.                             |
| Final logger matrix                                   | Real `StructuredLogger`/Pino destination   | FAIL; 11/11 new sensitive variants remained.                                                 |
| Architecture bypass plus package typecheck            | Compiling temporary foundation source      | FAIL; typecheck passed; architecture violations reported: 0.                                 |
| Security subprocess tree                              | Linux Node 22.14.0 container               | FAIL; direct child terminated; descendant survived and was then cleaned.                     |
| Secret detector corpus                                | Custom scanner and Trivy 0.70.0            | FAIL; four contextual credential forms missed by both; local control detected.               |
| Runtime outbox mutation                               | Physical restricted login / fresh database | FAIL; event and same-state claim metadata rewrites accepted.                                 |
| `corepack pnpm security:dependencies`                 | Clean checkout / TLS verification retained | FAILED CLOSED; registry returned no valid local report.                                      |

The first clean-checkout attempt under `%TEMP%` reached unit-test startup but esbuild could not read
parent directories because of sandbox permissions. This is an **AUDIT ENVIRONMENT LIMITATION**, not a
repository failure. The replacement isolated checkout inside the writable workspace completed the
frozen install and root verification successfully.

The local dependency audit failed closed after an invalid registry response; TLS verification was
not disabled. The authenticated exact-commit hosted report supplies the current dependency result:
zero Info, Low, Moderate, High, or Critical advisories.

## Hosted CI and artifacts

Authenticated read-back independently confirmed both clean runs:

| Run           | Commit                                     | Quality        | Integration    | Security       | Required       | Result  |
| ------------- | ------------------------------------------ | -------------- | -------------- | -------------- | -------------- | ------- |
| `34271765472` | `a442d2e6e588de299d1515e3c61ec974fc8971f1` | `102214806336` | `102214806230` | `102214806197` | `102215415238` | SUCCESS |
| `34273021851` | `ef6ed76b16394bbacf9e34337bf0be5aae4a4a17` | `102219113629` | `102219113320` | `102219113758` | `102219907794` | SUCCESS |

The final run executed the intended checkout, Node setup, frozen install, quality, coverage,
database/process, dependency, secret, license, Docker, Trivy filesystem/image, evidence upload,
cleanup, and aggregate-gate steps. It is bound to the exact audited commit.

For each run, all three artifacts were downloaded and all 44 extracted files were enumerated, hashed,
and inspected. Both contain 70/70 unit tests, 19/19 integration tests, 12/12 database invariants, zero
dependency advisories, zero reported filesystem/image vulnerabilities, and zero Dockerfile
misconfigurations. No private-key block, credential-bearing database URL, unredacted bearer,
unredacted PostgreSQL `secretKey`, `.env` artifact, or private certificate/key file was confirmed.

Final-run artifacts are quality `10074650045`, integration `10074617021`, and security
`10074608536`. Historical run `34270806808` and known-bad artifact `10073766304` still exist and were
not deleted or modified; they preserve the earlier incident evidence.

GitHub warned that the SHA-pinned checkout, setup-node, and upload-artifact versions target Node.js 20
and were forced onto Node.js 24. This is **NON-BLOCKING HARDENING**: it did not bypass a check or alter
the repository's Node 22.14.0 test runtime. Refresh the action pins through reviewed maintenance
before GitHub removes the compatibility path. Action-runtime `punycode`/`url.parse()` deprecations are
also non-blocking and do not originate in Trayvi runtime code.

## Security assessment

Dependency/tool results and adversarial code findings are kept distinct:

- **Dependency and hosted tools:** Exact-commit dependency, filesystem, image, license, and current
  secret scans are green; no current advisory or exposed artifact secret was found. The local
  registry audit failed closed.
- **Adversarial code findings:** Final logging leaks realistic sensitive classes; architecture rules
  can be bypassed by compiling forms; security subprocess teardown leaves a POSIX descendant;
  project-native credentials evade both configured detectors; runtime SQL can rewrite outbox
  evidence and claim metadata.
- **TLS/commands/environment:** Migration TLS downgrade attempts fail closed. Subprocess commands use
  fixed executables/argument arrays rather than a shell. Generated test credentials were ephemeral,
  value-free evidence was retained, and temporary files were removed.

## AC-031 governance deferral

Authenticated GitHub read-back shows a private repository, one merge-capable collaborator (the
owner), no deployments, no environments, no branch protection, and rulesets unavailable under the
current plan. The workflow triggers on pull requests and pushes to `main`, uses least permission and
timeouts, and its required gate passed. None of the documented reopening triggers exists: no
production-connected deployment, second merge-capable collaborator, deployment automation from
`main`, critical real infrastructure exposure, or Production Readiness milestone.

AC-031 remains **DEFERRED — PRE-PRODUCTION GOVERNANCE**. The deferral is legitimate, documented, and
is neither removed nor represented as PASS.

## Acceptance criteria

| Criterion  | Status                                   | Current evidence                                                                     |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| AC-001     | PASS                                     | Exact clean target, repository policy, and generated/secret exclusions verified.     |
| AC-002     | PASS                                     | Node and pnpm are pinned and verified locally and in CI.                             |
| AC-003     | PASS                                     | Isolated checkout completed setup without prior dependency/build state.              |
| AC-004     | PASS                                     | Frozen install completed from the committed lockfile.                                |
| AC-005     | PASS                                     | Root verification passed locally and in exact-commit CI.                             |
| AC-006     | PASS                                     | Only justified Phase 0 apps/packages exist.                                          |
| AC-007     | PASS                                     | Format, lint, strict types, and five builds passed.                                  |
| **AC-008** | **FAIL**                                 | A compiling foundation-to-app dynamic import evaded the boundary gate.               |
| **AC-009** | **FAIL**                                 | Reflective process environment access evaded the configuration boundary.             |
| AC-010     | PASS                                     | Required ADRs are present and were reviewed.                                         |
| AC-011     | PASS                                     | Critical configuration failures remain value-safe and fail closed.                   |
| AC-012     | PASS                                     | Production/staging unsafe defaults and TLS downgrade forms were rejected.            |
| AC-013     | FAIL                                     | Both configured detectors missed demonstrated project-native credential forms.       |
| **AC-014** | **FAIL**                                 | Common credential/private/session variants crossed final Pino output.                |
| AC-015     | PASS                                     | API errors retain a stable safe response envelope and request ID.                    |
| AC-016     | PASS                                     | Exact-commit dependency/filesystem/image scans contain no blocked finding.           |
| AC-017     | PASS                                     | Disposable PostgreSQL/PostGIS became healthy.                                        |
| AC-018     | PASS                                     | Empty migration apply and repeat no-op passed.                                       |
| AC-019     | PASS                                     | Rollback/forward, failure, checksums, and concurrency passed.                        |
| AC-020     | PASS                                     | Physical runtime identity cannot perform schema/admin operations.                    |
| AC-021     | PASS                                     | No product/domain table or market hardcoding exists.                                 |
| AC-022     | PASS                                     | API/worker startup and bounded, truthful shutdown passed.                            |
| AC-023     | PASS                                     | Liveness independence and readiness loss/recovery passed.                            |
| AC-024     | PASS                                     | Health/API responses remain secret and topology safe.                                |
| AC-025     | PASS                                     | Request/correlation validation and isolation passed.                                 |
| **AC-026** | **FAIL**                                 | The mandatory logging boundary can emit credentials/private material.                |
| **AC-027** | **PASS**                                 | Service request, readiness, and shutdown limits are explicit and tested.             |
| AC-028     | PASS                                     | Clean Windows executable tests and hosted Linux tests passed.                        |
| AC-029     | PASS                                     | Integration tests used isolated real PostgreSQL/PostGIS.                             |
| **AC-030** | **PASS**                                 | Every failure path enumerated by the criterion is covered and passed.                |
| **AC-031** | **DEFERRED — PRE-PRODUCTION GOVERNANCE** | Deferral triggers remain absent; configured hosted controls/jobs passed.             |
| AC-032     | PASS                                     | Test, scan, migration, and build artifacts remain retained and inspected.            |
| **AC-033** | **FAIL**                                 | Logging, architecture, tooling, and outbox docs overstate enforcement.               |
| AC-034     | PASS                                     | Historical AC mapping and evidence remain preserved.                                 |
| **AC-035** | **FAIL**                                 | Four prior findings are reopened and one new blocking finding remains.               |
| **AC-036** | **PASS**                                 | Historical reports remain complete/unchanged; this report records the truthful FAIL. |

Totals: **28 PASS, 7 FAIL, 1 DEFERRED**.

## Documentation and retained evidence

- Second re-audit: this `SECOND-RE-AUDIT.md`.
- Safe evidence: `evidence/second-re-audit/target.json`, `adversarial-results.json`,
  `verification-summary.json`, and `hosted-verification.json`.
- Historical reports: `AUDIT.md`, `REMEDIATION.md`, `RE-AUDIT.md`, and `REMEDIATION-2.md` remain
  byte-for-byte unchanged at the hashes above.

No actual or synthetic credential value, raw log, `.env` content, certificate/private key, database
dump, or temporary probe source is retained.

## Temporary resource cleanup

The disposable PostGIS container, isolated POSIX probe container, generated roles/databases,
temporary checkout, downloaded artifact copies, probe sources/results, and the deliberately surviving
descendant were removed. No named network or volume was created. Historical GitHub artifacts were not
deleted or altered.

## Residual risk and decision

Phase 0 cannot close while P0-AUD-001, P0-AUD-004, P0-AUD-007, P0-REAUD-001, and
P0-REAUD2-001 remain open. The normal tests and current artifacts are clean and internally
consistent, but they do not exercise these reproduced boundaries. No remediation was made during
this audit. Phase 1 remains unauthorized.

# PHASE 0 SECOND RE-AUDIT — FAIL
