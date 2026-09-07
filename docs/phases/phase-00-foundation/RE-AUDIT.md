# Phase 0 — Adversarial Re-Audit

**Decision:** PHASE 0 RE-AUDIT FAILED — ADDITIONAL REMEDIATION REQUIRED  
**Date:** 2026-09-07  
**Original audit target:** `6b977aa4eb078f4079cb24cbd1370244d31c7e17`  
**Remediation target:** `01f360aa717593458beae3123db3de925f3fb319`  
**Re-audit target:** `01f360aa717593458beae3123db3de925f3fb319`  
**Target tree:** `87bcaac4c86b5c76dac6b8f98041b0e04eae882d`  
**Branch:** `main`  
**Remote:** `https://github.com/SaulL08/Trayvi.git`  
**Scope:** Phase 0 re-audit only; Phase 1 remains unauthorized

## Target integrity and limitations

At entry, the worktree was clean and local `HEAD` equaled local `origin/main` at the re-audit target.
The target commit and tree were checked again before documentation. The original [AUDIT.md](AUDIT.md)
had SHA-256 `3EF87D28459B5B5F608CBC202253EACF0F2D27F84E6EC6354601AF7A292F22F1`
at both boundaries and was not edited.

The authorization identifies GitHub Actions run `34149350569` on `ubuntu-24.04` as successful for
the target. Live GitHub branch/run read-back could not be completed: Windows Git credential access
was unavailable, the CLI returned no accessible run, and the connected GitHub read transport failed.
This report treats the run metadata as supplied evidence, not independently verified evidence. The
target remained fixed locally throughout discovery.

## Methodology

- Re-read the project overview, architecture vision, roadmap, security and Trust & Safety principles,
  system master plan, Phase 0 plan, implementation, original audit, remediation record, ADRs and all
  audit/remediation evidence.
- Inspected remediation commits and every affected logging, API, worker, configuration, migration,
  database-role, outbox, architecture, security and CI source and test.
- Ran the root gate independently and challenged fixes with temporary ignored harnesses rather than
  relying on remediation tests alone.
- Used a disposable PostgreSQL 17/PostGIS 3.5 container for physical-login, DDL, role, migration,
  concurrency and outbox attacks. It contained no production or personal data.
- Repeated a broader Phase 0 sweep across clean checkout identity, frozen-install behavior, health,
  readiness, API errors, worker lifecycle, telemetry failure, CI permissions/action pinning,
  container hardening and supply-chain controls.
- Removed temporary harnesses and the disposable database after capturing only booleans, counts and
  identifiers safe to version. No finding was repaired during discovery.

## Original findings status

| ID         | Original severity | Status               | Adversarial result                                                                                                                                                                                 |
| ---------- | ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-AUD-001 | HIGH              | REOPENED             | A string-only logger event reaches Pino's final `message` unsanitized; percent-encoded `key%3Dvalue` text also retains the canary.                                                                 |
| P0-AUD-002 | HIGH              | CLOSED               | Normal work drains; cancelable timeout work observes abort; non-cancelable deadline expiry marks `FAILED`, emits `api.shutdown.incomplete`, and omits `api.stopped`.                               |
| P0-AUD-003 | HIGH              | CLOSED               | Real-DB probes reject unknown, missing/gapped, incomplete and drifted history; valid prefix/no-op/down/up, rollback and concurrent apply behave transactionally.                                   |
| P0-AUD-004 | MEDIUM            | PARTIALLY_REMEDIATED | Package/deep/relative fixtures are caught, but a compiling `tsconfig` path alias plus a forward process alias with a statically computable property produces zero violations.                      |
| P0-AUD-005 | MEDIUM            | PARTIALLY_REMEDIATED | Explicit staging/production downgrade and conflicting URL parameters fail, but migration config silently defaults missing `NODE_ENV` to development and accepts TLS-disabled remote configuration. |
| P0-AUD-006 | MEDIUM            | CLOSED               | Physical runtime identity is restricted; administrative DDL, grants, role creation/switching, session authorization and extension creation are denied, with no transitive admin membership.        |
| P0-AUD-007 | MEDIUM            | PARTIALLY_REMEDIATED | Coherent row shapes and DELETE denial hold, but runtime can jump directly from `pending` to `published` by updating the coupled fields in one statement.                                           |
| P0-AUD-008 | MEDIUM            | CLOSED               | Getters were not invoked; proxy reflection failures, revoked proxies, cycles, custom errors, null prototypes, symbols, BigInt, functions, arrays and maps were contained without canary output.    |
| P0-AUD-009 | MEDIUM            | CLOSED               | Twenty-five concurrent timeout requests preserved the exact request/correlation pair on responses and failure/completion logs without cross-request bleed.                                         |
| P0-AUD-010 | MEDIUM            | CLOSED               | A controlled Moderate report retained advisory ID, package/version/ranges, scope and disposition state and failed deterministically without current triage.                                        |
| P0-AUD-011 | LOW               | CLOSED               | Reachable history scans pass, explicit no-history works, non-repositories fail closed, large history streams, and history-only canaries are detected.                                              |

### Reopened P0-AUD-001 — final logger message bypass

`StructuredLogger.#write` sanitizes a record containing `event`, then calls Pino with the original
event again as the message argument. A canary in `logger.info("password=<canary>")` is therefore
redacted in the JSON `event` field but survives in JSON `message`. `sanitizeForLogging` also leaves
`password%3D<canary>` intact. This preserves the essential High-impact path: secret-bearing free-form
text can reach general logs and exporters. It blocks AC-014 and AC-026.

### Partially remediated P0-AUD-004 — resolvable aliases remain outside the gate

The AST gate improved materially, but it does not resolve `compilerOptions.paths` and only recognizes
literal environment property names in traversal order. A temporary foundation package compiled an
import from `#api/bootstrap` mapped to an application, then read a forward-declared process alias via
`['e' + 'nv']`. `inspectArchitectureFiles` returned no violation. Both forms are statically
resolvable and within the requested gate threat model. This blocks AC-008 and AC-009.

### Partially remediated P0-AUD-005 — missing environment weakens migration TLS

When `NODE_ENV` is explicitly `staging` or `production`, disabled/malformed TLS and URL conflicts fail
closed. `parseMigrationConfig`, however, defaults an absent `NODE_ENV` to `development`, contrary to
the configuration reference that marks it required. A remote migration URL with omitted environment
therefore produces `{ mode: "disable" }`. This configuration mistake removes the claimed
staging/production fail-closed boundary for migration traffic. It blocks AC-011 and AC-012.

### Partially remediated P0-AUD-007 — valid-state transition skipping

The new constraint rejects contradictory row shapes and runtime DELETE is denied. Using the physical
runtime login, an inserted `pending` row could still be changed directly to `published` by setting
`status`, `attempts` and `published_at` together. The final shape is valid, but no claim/processing
transition occurred. Because ADR-008 defers the active consumer, this remains Medium rather than High;
it must be resolved or explicitly narrowed before an outbox consumer is enabled. It invalidates the
current documentation claim that the enforced model supplies transition integrity.

## New findings

| ID           | Severity | Area                            | Title                                                         | Blocking |
| ------------ | -------- | ------------------------------- | ------------------------------------------------------------- | -------- |
| P0-REAUD-001 | LOW      | Security tooling / availability | Git and dependency-audit subprocesses lack internal deadlines | No       |

### P0-REAUD-001 — security subprocesses rely on the outer CI deadline

`scanGitHistory` starts `git log` without a kill deadline. The dependency audit likewise starts pnpm
without checking the child exit code or applying an internal deadline. During re-audit the live
dependency command remained pending on registry retries until manually interrupted. The hosted
security job has a 20-minute timeout, so this does not fail open, but local gates and partial CI
evidence can hang for the entire outer bound. Add explicit child deadlines, termination, exit-code
validation and tests for timeout/partial output.

New-finding counts:

```text
CRITICAL: 0
HIGH:     0
MEDIUM:   0
LOW:      1
INFO:     0
```

Open risk including original findings:

```text
CRITICAL: 0
HIGH:     1
MEDIUM:   3
LOW:      1
INFO:     0
```

## Existing controls challenged

- `corepack pnpm verify`: PASS — 14 unit files, 58 tests, 323 license entries, architecture/secret
  gates and five builds.
- The documented `test:integration:local` command first failed because ignored local environment
  files pointed at a different port and no longer matched the persisted volume credentials. This was
  classified as workstation state, not target code; the audit moved to a fresh disposable database.
- Isolated Windows integration: PASS — 17 tests; two compiled POSIX signal cases skipped as expected.
- Disposable database verification: PASS — all 11 reported PostGIS, migration, role, outbox and
  concurrency invariants.
- Runtime identity: `session_user` and `current_user` were the physical runtime login; only the
  restricted NOLOGIN role was inherited. Runtime alteration of its own default privileges was
  accepted by PostgreSQL but provided no escalation because it cannot create schema objects.
- Configuration: explicit TLS downgrade/conflict cases failed; the missing-environment bypass did not.
- Sanitization: hostile reflection corpus remained available and canary-free; logger event/message
  duplication bypassed the sanitizer.
- Correlation: the concurrent timeout set retained all 25 unique ID pairs.
- Moderate advisory fixture: complete identity was retained and untriaged Moderate failed.
- Secret history scan: repository and reachable history passed; static inspection found no internal
  subprocess timeout.

## Full Phase 0 sweep

| Control                     | Result                        | Evidence/limitation                                                                                                                                    |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean target                | PASS                          | Entry worktree clean; commit/tree fixed and local `origin/main` matched.                                                                               |
| Clean checkout              | PARTIAL                       | Fresh local clone matched commit/tree and lock hash; offline store lacked a package and safe online install was blocked by the host certificate chain. |
| Frozen install              | SUPPLIED HOSTED PASS          | Run `34149350569` reports success; live read-back was unavailable. TLS verification was not disabled locally.                                          |
| Config and safe errors      | FAIL                          | Safe API envelopes survived; migration `NODE_ENV` and logger-message bypasses remain.                                                                  |
| Health/readiness            | PASS                          | Liveness independence, DB-down readiness and recovery passed against real PostgreSQL.                                                                  |
| API/worker lifecycle        | PASS                          | Timeout/drain tests and worker close passed; Linux-only compiled signals rely on supplied hosted evidence.                                             |
| PostgreSQL/PostGIS          | PASS                          | Disposable service healthy; PostGIS and 11 database invariants passed.                                                                                 |
| Migration locking/integrity | PASS                          | Concurrent apply serialized; invalid SQL rolled back; drift/corruption cases rejected.                                                                 |
| Outbox                      | FAIL                          | Atomicity, coherent shapes and DELETE denial pass; direct transition skipping remains.                                                                 |
| Telemetry failure           | PASS                          | Failure/hang containment unit probes passed.                                                                                                           |
| CI policy                   | PASS WITH GOVERNANCE DEFERRED | Workflow permissions are `contents: read`, jobs/timeouts exist, actions are SHA-pinned and the aggregate gate is explicit. AC-031 remains deferred.    |
| Container                   | PASS                          | User `70:70`, effective capabilities zero, root not writable, data directory writable, 1 GiB/2 CPU Compose limits and loopback port binding.           |
| Dependency security         | LIMITED                       | Controlled Moderate policy probe passed; supplied hosted counts are zero; live registry audit was unavailable due the host certificate chain.          |
| Secret scanning             | PASS WITH LOW FINDING         | Current and reachable-history scan found zero; internal command timeout is missing.                                                                    |

## Security evidence

Current local/re-audit evidence:

```text
Critical findings:       0
High findings:           1
Moderate findings:       3
Repository secrets:      0
Misconfigurations:       no live Trivy refresh; supplied hosted count 0
Dependency advisories:   no live registry result; supplied hosted Critical/High/Moderate 0/0/0
```

The live dependency scan and clean-checkout download failed because the host could not verify the
registry certificate chain. TLS verification was not weakened. The supplied hosted run remains the
only current dependency/misconfiguration count for the final target.

## Acceptance criteria

| Criterion  | Status                                   | Re-audit basis                                                                                                                     |
| ---------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AC-001     | PASS                                     | Clean, committed target; ignored secrets/harnesses are not versioned.                                                              |
| AC-002     | PASS                                     | Node 22.14.0 and pnpm 11.25.0 remain pinned and the toolchain check passed.                                                        |
| AC-003     | PASS WITH LIMITATION                     | Clean clone identity and lock matched; dependency download was environment-blocked; supplied hosted clean execution remains green. |
| AC-004     | PASS WITH LIMITATION                     | Lock is frozen and unchanged; current clean install was certificate-blocked; supplied hosted frozen install passed.                |
| AC-005     | PASS                                     | Root verification completed successfully.                                                                                          |
| AC-006     | PASS                                     | Only the justified Phase 0 apps/packages exist.                                                                                    |
| AC-007     | PASS                                     | Format, lint, strict types and all five builds passed.                                                                             |
| AC-008     | FAIL                                     | Compiling `tsconfig` path-alias boundary bypass was not detected.                                                                  |
| AC-009     | FAIL                                     | Forward alias plus computed environment access was not detected.                                                                   |
| AC-010     | PASS                                     | ADR-001–ADR-010 remain accepted; ADR-019 records remediation invariants.                                                           |
| AC-011     | FAIL                                     | Migration configuration accepts a missing environment and defaults to insecure development TLS.                                    |
| AC-012     | FAIL                                     | The same omission bypasses the intended staging/production migration TLS gate.                                                     |
| AC-013     | PASS                                     | Repository/current-history scan found zero secrets; examples contain no usable credential.                                         |
| AC-014     | FAIL                                     | String-only logger messages and percent-encoded assignments leak the canary.                                                       |
| AC-015     | PASS                                     | Unexpected API errors retain a stable safe envelope and request ID.                                                                |
| AC-016     | PASS WITH LIMITATION                     | Supplied hosted scans report zero Critical/High; live dependency/Trivy refresh was unavailable.                                    |
| AC-017     | PASS                                     | PostgreSQL 17/PostGIS 3.5 became healthy in an isolated container.                                                                 |
| AC-018     | PASS                                     | Empty apply and repeat no-op passed.                                                                                               |
| AC-019     | PASS                                     | Rollback/roll-forward, failure and concurrent migration behavior passed.                                                           |
| AC-020     | PASS                                     | Physical runtime identity could not perform schema DDL or restore admin authority.                                                 |
| AC-021     | PASS                                     | No product/domain table or market hardcoding was introduced.                                                                       |
| AC-022     | PASS                                     | API/worker lifecycle and truthful incomplete-shutdown behavior passed.                                                             |
| AC-023     | PASS                                     | Liveness/readiness loss and recovery passed.                                                                                       |
| AC-024     | PASS                                     | Health and API error responses remained topology/secret safe.                                                                      |
| AC-025     | PASS                                     | Valid and hostile IDs normalize and concurrent IDs do not bleed.                                                                   |
| AC-026     | FAIL                                     | The final logger boundary can emit a secret-bearing message.                                                                       |
| AC-027     | PASS                                     | Request/readiness/shutdown limits are explicit and exercised.                                                                      |
| AC-028     | PASS WITH LIMITATION                     | Windows suites passed with documented POSIX skips; Linux result is supplied hosted evidence.                                       |
| AC-029     | PASS                                     | Re-audit integrations used isolated real PostgreSQL/PostGIS.                                                                       |
| AC-030     | FAIL                                     | Missing migration environment and security-process timeout paths are not safely bounded as claimed.                                |
| **AC-031** | **DEFERRED — PRE-PRODUCTION GOVERNANCE** | Preserved exactly as required; no branch-governance mutation was attempted.                                                        |
| AC-032     | PASS WITH LIMITATION                     | Remediation evidence identifies retained artifacts; live artifact read-back was unavailable.                                       |
| **AC-033** | **FAIL**                                 | Configuration, observability and outbox documentation overstate behavior found by re-audit.                                        |
| AC-034     | PASS                                     | Implementation records map the original criteria; this report supersedes affected conclusions.                                     |
| **AC-035** | **FAIL**                                 | Re-audit ran, but one original High is reopened and Medium bypasses remain.                                                        |
| **AC-036** | **PASS**                                 | Original `AUDIT.md` is hash-identical and this re-audit is separate.                                                               |

Re-audit matrix totals: **26 PASS/PASS WITH LIMITATION, 9 FAIL, 1 DEFERRED**.

## Documentation and evidence

- Original audit: [AUDIT.md](AUDIT.md), unchanged SHA-256
  `3EF87D28459B5B5F608CBC202253EACF0F2D27F84E6EC6354601AF7A292F22F1`.
- Remediation claim: [REMEDIATION.md](REMEDIATION.md), retained unchanged.
- Re-audit target: [target.json](evidence/re-audit/target.json).
- Adversarial results: [adversarial-probes.json](evidence/re-audit/adversarial-probes.json).
- Verification summary: [verification-summary.json](evidence/re-audit/verification-summary.json).

No raw log, environment file, credential, certificate, private key, database dump, canary value or
temporary harness is retained as versioned evidence.

## Final decision

One original High finding is reproducible at the final log boundary. Three Medium controls remain
partially enforceable, including statically resolvable architecture bypasses and migration TLS policy
weakening. AC-035 cannot pass, and Phase 0 cannot pass while the High finding remains open.

# PHASE 0 RE-AUDIT FAILED — ADDITIONAL REMEDIATION REQUIRED

Phase 1 has not been started and remains unauthorized.
