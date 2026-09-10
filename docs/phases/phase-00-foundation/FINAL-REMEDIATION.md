# Phase 0 — Final Blocking Findings Remediation

**Status:** FINAL REMEDIATION LOCALLY VERIFIED — READY FOR HOSTED CI AUTHORIZATION  
**Base commit:** `c017a269fa7cdb94eb25cf7a77c3e5c3b702eac9`  
**Verified code head:** `fc8dd16c87ee93b2eb00f1b980f52bedd5a54110`  
**Verified code tree:** `b5b50ffa4dc32fde186de25a081f85a33ade6fc7`  
**Scope:** the five blocking findings from the Phase 0 Second Re-Audit only

This record is chronological. It does not revise the failed audit reports, approve Phase 0, start
the final independent audit, or authorize Phase 1.

## Findings

| Finding       | Severity | Previous | Root cause                                                                                                 | Fix and regression                                                                                                                                                                                                                                                                               | Fix commit                                 | Final |
| ------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----- |
| P0-AUD-001    | HIGH     | REOPENED | The final sanitizer lacked credential/private-key/session aliases and PEM text handling.                   | Added normalized sensitive classes and PEM redaction; final Pino JSON tests cover messages, objects, nested arrays, Error/cause/AggregateError, API, worker, and subprocess diagnostics while retaining safe IDs and keyboard keys.                                                              | `2aaaba807ea4339f9d414504f5e0c7bd3a426854` | FIXED |
| P0-AUD-004    | MEDIUM   | REOPENED | Reflective process access and statically bound dynamic imports escaped AST checks.                         | The gate resolves constant/template import targets, recognizes `Reflect.get` process/env aliases, and rejects unresolved foundation dynamic imports. Malicious fixtures produce violations; the repository produces zero.                                                                        | `fc5c095cffb0e788f596517476b3448c9f20465d` | FIXED |
| P0-AUD-007    | MEDIUM   | REOPENED | Table-wide UPDATE and a status-only trigger allowed event and same-state claim rewrites.                   | Migration `0004` revokes table-wide UPDATE, grants lifecycle-column updates, makes the event envelope immutable, and denies same-state metadata rewrites. PostgreSQL allows every defined transition and denies content, attempts, lock-owner, and DELETE probes.                                | `6d67ce615e1d57fdf6d247d22e998db77b095e70` | FIXED |
| P0-REAUD-001  | LOW      | REOPENED | Deadlines signalled only the direct child.                                                                 | POSIX children use process groups with graceful and forced group signals; Windows uses controlled `taskkill /T /F`. Completion waits for tree cleanup and closed streams. Resistant descendant probes pass on Windows and Linux.                                                                 | `1e4c9fb15aaa1d261f0ae8c20ae34940cd70c53b` | FIXED |
| P0-REAUD2-001 | MEDIUM   | OPEN     | The project scanner recognized provider signatures but missed contextual database and generic credentials. | Added contextual PostgreSQL, password/passwd, bearer, API, private-key and TLS-key patterns with deterministic length/entropy thresholds and a limited example/variable allowlist. Positive current/history fixtures are detected, negative fixtures stay clean, and findings contain no values. | `fc8dd16c87ee93b2eb00f1b980f52bedd5a54110` | FIXED |

## Post-fix probes

The final logging boundary removed every `passwd`, `credential`, `privateKey`, `sslKey`, `session`,
PEM-body, Error/cause, and AggregateError canary from serialized Pino output. Innocuous `safeId` and
`keyboardKey` fields remained useful.

The compiling architecture fixture uses `Reflect.get(globalThis, "process").env` and a prohibited
application import held in a constant/template target. Both paths report violations. Truly dynamic
imports from foundation packages fail closed with `UNRESOLVED_FOUNDATION_DYNAMIC_IMPORT`; the gate
does not attempt to interpret arbitrary JavaScript.

The physical PostgreSQL runtime login cannot update `event_type` or `payload`, cannot rewrite
`attempts` or `locked_by` while keeping the same state, and cannot DELETE. Pending/failed claims and
processing completion continue to follow ADR-008. All fourteen database invariants pass on a clean
PostgreSQL 17/PostGIS 3.5 instance.

The Linux timeout harness created a direct process and a signal-resistant descendant in one process
group. The deadline sent SIGTERM, waited for the grace interval, escalated to SIGKILL, observed no
live descendant, closed streams, and rejected partial output. The equivalent Windows tree probe also
passed.

The project secret corpus detects credentialed PostgreSQL URLs, password and passwd assignments,
opaque authorization bearer values, contextual API/private/TLS keys, and private-key material.
Environment substitutions, explicit placeholders/examples, generated values, public hashes, and
public IDs remain clean. Tree and reachable-history scans report zero findings.

## Regression sample

The full unit, integration, database, architecture, configuration, migration, and supply-chain
policy runs re-exercised P0-AUD-002, P0-AUD-003, P0-AUD-005, P0-AUD-006, P0-AUD-008,
P0-AUD-009, P0-AUD-010, and P0-AUD-011. No regression was observed.

## Verification

- Windows workspace `verify`: PASS — format, lint, typecheck, architecture, tree/history secrets,
  323 installed-package license records, 75 unit tests, one POSIX-only skip, and five builds.
- Windows integration: PASS — 17 executable tests; two POSIX-only tests skipped and covered below.
- Windows clean checkout: PASS — no-hardlink clone, frozen offline install of 267 packages with zero
  downloads, no reused `node_modules` or pre-existing build cache, root verification, 75 unit tests,
  and five builds.
- Linux clean checkout: PASS — exact commit/tree cloned into a new native Docker volume; frozen
  offline install of 266 packages with zero downloads; format, lint, eight typecheck tasks with zero
  cache hits, architecture, tree/history secrets, 266 licenses, 76/76 unit tests, five builds,
  19/19 integration tests, API/worker SIGTERM, process-tree escalation, and 14/14 DB invariants.
- Dependency audit: FAILED CLOSED — the local registry path returned no valid report. Certificate
  verification was not disabled, the remediation did not change the lockfile, and a fresh hosted
  result remains pending authorization.

Machine-readable details are under `evidence/final-remediation/`.

## Historical integrity

The five historical reports were hash-checked and not edited:

| Record               | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `AUDIT.md`           | `3EF87D28459B5B5F608CBC202253EACF0F2D27F84E6EC6354601AF7A292F22F1` |
| `REMEDIATION.md`     | `BC1E7A9AEBCC70DA2159A051BB277B7A05531FD19886A5B2A719C6F954BB00A2` |
| `RE-AUDIT.md`        | `B1BD26F64A4DBBB584C6ED29A2DF42C465618C634E4965AEA85449256320B328` |
| `REMEDIATION-2.md`   | `1DFA947E520CD024BACC7FFDBB836AEDE1EF1FE347D43B3154B522B15BE80BD8` |
| `SECOND-RE-AUDIT.md` | `07803A2831908B5CE803F974C0E656C8903C2ED7EAAEA4C72FAC3653C28E98B0` |

## Acceptance and next gate

- `AC-031`: **DEFERRED — PRE-PRODUCTION GOVERNANCE**.
- `AC-035`: **FAIL / PENDING FINAL RE-AUDIT**. Remediation cannot self-approve closure.
- `AC-036`: **PASS**. Historical audit outcomes remain intact.
- Hosted CI: **PENDING AUTHORIZATION**.
- Phase 1: unauthorized.

## Decision

**FINAL REMEDIATION LOCALLY VERIFIED — READY FOR HOSTED CI AUTHORIZATION**
