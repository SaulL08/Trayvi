# Phase 1 — Accounts and Identity — Implementation

Status: **IMPLEMENTATION COMPLETE; READY FOR SEPARATELY AUTHORIZED ADVERSARIAL AUDIT**

Plan baseline: `56e0065f8eee35f79e819455564e0e9ab3dec7db`

Functional implementation commit: `ac90421068185706f49919384b98ffedfcc70001`

Implementation evidence commit: `efe7fee3b639d5c76c8337285b6948dea8d01cd3`

Hosted harness fix and verified implementation commit:
`b0375079e90d75482e7aa477492ddc3437e8f431`

This document records the authorized Phase 1 implementation. It is not an
adversarial audit, does not close Phase 1, and does not authorize Phase 2.

## 1. Delivered scope

The implementation adds Accounts and Identity foundations only:

- distinct Account, Person Identity, Identity Document, Fingerprint Claim,
  Verification Case, Verification Evidence, Review, Enrollment Operation, and
  lifecycle-transition concepts;
- pure Accounts and Identity domain workspaces, provider-neutral application
  ports, synthetic test-only crypto providers, and API composition/repository
  seams;
- deterministic Dominican cédula formatting normalization, protected document
  envelopes, blocking HMAC aliases, transaction-safe duplicate handling, and
  safe public conceptual outcomes;
- immutable SQL migrations `0005` through `0007`, real-PostgreSQL constraints,
  lifecycle guards, runtime grants, transaction tests, rotation drills, and
  evidence.

No password, login, OTP, session, refresh token, recovery, general RBAC, driver
onboarding, vehicle, pricing, trip, payment, or Phase 2 behavior is present.

## 2. Architecture and workspaces

`@trayvi/accounts` owns Account lifecycle and enrollment-operation domain
contracts. `@trayvi/identity` owns document normalization, identity lifecycle,
document protection ports, fingerprint keyring contracts, and provider-neutral
crypto behavior. API composition coordinates them without making Accounts a
reader of restricted document material.

The architecture checker now understands `modules/*` workspaces and enforces:

```text
domain <- application <- infrastructure
no cross-module infrastructure imports
no deep workspace imports
```

The real-repository gate reports zero violations. Positive and negative fixtures
cover allowed application composition, forbidden domain-to-infrastructure
imports, and forbidden cross-module infrastructure access.

## 3. Database delivery

### 3.1 Migrations

| Migration                                     | Purpose                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `0005_accounts_identity_core`                 | Account, operation, Person Identity, and transition-history foundations          |
| `0006_identity_document_protection`           | encrypted document envelopes, blocking fingerprint claims, restricted grants     |
| `0007_identity_verification_lifecycle_guards` | verification/review tables, transition guards, activation evidence, immutability |

Migrations `0001` through `0004` are unchanged. The new migrations have matching
down files and pass clean apply, repeat/no-op, refusal to destructively roll back
live Phase 1 data, three-down/three-up, invalid-migration rollback, and concurrent
migration serialization. Checksums are in
[`evidence/migration-evidence.json`](evidence/migration-evidence.json).

### 3.2 Tables

```text
accounts.accounts
accounts.account_creation_operations
accounts.account_status_transitions
identity.person_identities
identity.identity_status_transitions
identity.identity_documents
identity.document_fingerprint_claims
identity.verification_cases
identity.verification_evidence
identity.identity_reviews
```

### 3.3 Enforced invariants

PostgreSQL, rather than TypeScript alone, enforces:

- one Person Identity per base Account;
- one current protected document for its complete document scope;
- one blocking fingerprint alias for the complete country/issuer/type/profile/
  key-version/fingerprint scope;
- account activation only with exactly one established identity and a bound
  fingerprint claim;
- legal Account, Identity, document, claim, verification-case, and review state
  transitions;
- terminal-state non-reopening, immutable transition/evidence rows, and immutable
  protected document context;
- required actor, reason, evidence/policy reference, old/new state, version, and
  timestamp for material transitions.

The physical runtime login is denied restricted envelope/fingerprint columns,
protected rewrites, protected deletes, arbitrary DDL, administrator role
escalation, and direct lifecycle bypass. Phase 0 outbox immutability and runtime
protections remain active.

## 4. Identity protection

### 4.1 Normalization

`do-cedula-v1` accepts approved formatting and whitespace variants and produces
exactly 11 ASCII digits. It rejects invalid lengths, non-digits, non-string
values, and unsupported forms without echoing the submitted value.

Normalization returns a format result only. Structural/checksum assessment is a
different type and currently reports `NO_APPROVED_RULESET`. Trusted verification
is a third type and requires an explicit verified outcome. Formatting cannot
activate an Account.

### 4.2 Fingerprints

Blocking claims use HMAC-SHA-256 with the exact PLAN domain-separated,
NUL-delimited byte contract, external key material, and explicit key versions.
Tests reproduce the published vector and mutate every scope field, key, value,
separator, and encoding. No plain or unsalted document digest is used as the
uniqueness mechanism.

Key states are explicit:

```text
PRIMARY
LOOKUP_ACTIVE
RETIRED
```

Configuration fails closed unless exactly one PRIMARY exists and rejects reused
key material across versions.

### 4.3 Encryption and AAD

Each protected document receives a fresh AES-256-GCM DEK. A narrow external KEK
port wraps that DEK; only ciphertext, nonce, authentication tag, wrapped DEK,
KEK version, and non-secret crypto metadata persist.

AAD binds the envelope to document ID, Person Identity ID, country, issuer,
document type, normalization profile, and envelope schema. Unit tests reproduce
the PLAN vector and reject changes to every AAD field, ciphertext, tag, nonce,
missing envelope data, wrong KEK, and wrong key version.

### 4.4 Key separation and rotation

Document KEK, per-record DEK, fingerprint HMAC key, and idempotency-integrity key
are separate purposes and ports. Only controlled synthetic test adapters contain
test material; no production key is hardcoded.

HMAC rotation supports old plus new blocking aliases, concurrent dual-active
submissions, resumable/idempotent backfill, completeness verification, corrupt
target-alias detection, new-only cutover, and retirement. A pre-existing wrong
target alias fails the operation before promotion.

KEK rewrap locks the document transactionally, unwraps/rewraps the DEK through
the provider, verifies the entire new envelope before update, leaves document
ciphertext unchanged, emits an allowlisted safe event, and replays idempotently.
Wrong-provider rewrap fails without mutation. Recovered plaintext and DEKs are
zeroized at the adapter boundary.

## 5. Lifecycles

The Account states are exactly:

```text
PENDING_IDENTITY -> ACTIVE -> RESTRICTED/SUSPENDED -> CLOSED
```

Only the PLAN transitions are legal; the implementation tests the complete
5-by-5 matrix, optimistic version checks, allowed internal actor classes,
complete evidence fields, and terminal `CLOSED` behavior.

Identity, Verification Case, Review, Identity Document, and Fingerprint Claim
have independent exhaustive state matrices. Identity establishment requires
trusted verification evidence, an accepted review, and binding. Direct SQL
cannot silently establish, reopen, or release terminal/blocking relationships.

No reviewer/support mutation API or permission model is implemented. Those
operations remain disabled pending Phase 3 authorization and audit decisions.

## 6. Enrollment transaction and idempotency

One PostgreSQL connection and transaction span:

```text
enrollment operation
account
person identity
protected document envelope
all active fingerprint claims
transition history
outbox event
stored idempotency result
```

The service locks the operation row, validates a keyed, length-framed,
domain-separated request commitment, orders alias writes deterministically, and
stores the replay result. The same operation and same request replay the stored
result, including under concurrency. Expired or mismatched malicious reuse
returns a safe outcome and mutates no aggregate row.

Failure injection after each of seven material checkpoints leaves no partial
enrollment, orphan identity/document, dangling claim, invalid account, or
uncommitted outbox/idempotency result.

## 7. Concurrency and duplicate safety

The mandatory real-PostgreSQL test executed 50 simultaneous submissions in each
of 10 rounds against the same canonical document:

```text
total attempts:       500
aggregate winners:     10
safe conflicts:       490
duplicate accounts:     0
duplicate identities:   0
orphans:                0
```

Every round produced exactly one complete winner and 49 generic conflicts. The
partial unique index remains blocking across dual HMAC aliases, so rotation does
not create a duplicate-registration window.

## 8. Anti-enumeration and privacy

New and duplicate submissions share the same public result code, next step,
schema, serialized length, and status class. Public results contain no Account,
Identity, phone, email, document, fingerprint, ciphertext, key version, or
internal-reason identifier. Concurrent duplicates and expired/replayed
operations preserve the safe envelope.

Foundation Problem Details mapping now rejects internal exception detail and
supports fixed safe public codes. Recursive final-boundary redaction covers raw
and normalized document names, fingerprint/envelope fields, crypto keys, and
idempotency commitments without invoking getters or failing on hostile objects.
Outbox rotation/enrollment payloads are explicit allowlists and their tests scan
for forbidden keys and canaries.

The field-level inventory covers all 115 columns in all 10 Phase 1 tables with
classification, purpose, owner, readers/writers, retention/deletion trigger,
legal-hold treatment, event policy, and telemetry policy. Production enablement
remains blocked until the listed policies receive governance approval.

The threat/control register maps all 17 PLAN threats to code, database controls,
tests, documentation, residual risk, and a named later-phase or production
blocker. No Critical/High risk is silently accepted by the implementation.

## 9. Verification

The development workspace and an isolated detached worktree of the functional
commit passed the real project gates. The authoritative clean execution used a
fresh frozen install and `TURBO_FORCE=true`, producing zero cached typecheck or
build tasks.

```text
frozen install:       PASS (8 workspaces, 267 packages)
format:               PASS
lint:                 PASS
typecheck:            PASS (12/12 tasks, 0 cached)
architecture:         PASS (0 violations)
secret scan:          PASS (0 findings)
licenses:             PASS (267 packages, 0 findings)
unit:                 PASS (127 passed, 1 Windows-inapplicable skipped)
build:                PASS (7/7 tasks, 0 cached)
integration:          PASS (29 passed, 2 Windows-inapplicable skipped)
PostgreSQL/db verify: PASS (14/14 evidence flags)
dependency audit:    PASS (0 advisories at every severity)
```

The database tests used real PostgreSQL 17/PostGIS 3.5 infrastructure, not a
mock. TLS verification was not weakened: the local package client used an
exported Windows-trusted inspection root through `NODE_EXTRA_CA_CERTS`. No
`strict-ssl=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or equivalent bypass was
used.

### 9.1 Hosted verification

The first hosted implementation run, `34628242412` at evidence commit
`efe7fee3b639d5c76c8337285b6948dea8d01cd3`, is preserved as a failed run.
Quality and security passed, while integration failed before the Phase 1 tests
could execute. The root cause was a hosted harness ordering defect: the temporary
database was migrated before the cluster-level roles from
`infra/database/bootstrap/0001_roles.sql` existed. A secondary cleanup error then
attempted to close an uninitialized pool. This was not a regression in the
Accounts or Identity implementation.

Commit `b0375079e90d75482e7aa477492ddc3437e8f431` applies the minimum harness
correction. It runs the idempotent cluster bootstrap under a session advisory
lock before temporary-database migration, exercises concurrent bootstrap calls,
and closes only resources that initialized successfully while preserving the
primary setup error. It also prevents synthetic document fixtures from appearing
in machine-readable unit test names. No migration, Phase 0 file, or Phase 2
feature changed.

Hosted run `34662427613` executed that exact commit on GitHub-hosted
`ubuntu-24.04` runners and passed every mandatory job:

```text
quality job:          PASS (128/128 unit tests)
integration job:      PASS (31/31 integration tests; 14/14 DB checks)
security job:         PASS (0 dependency, secret, license, filesystem, image,
                      or misconfiguration findings under the enforced policy)
required gate:        PASS
concurrency contract: PASS (500 attempts, 10 winners, 490 safe conflicts,
                      0 duplicate Accounts, 0 duplicate Identities, 0 orphans)
failure injection:    PASS (7/7 checkpoints)
```

All three hosted artifacts were downloaded and inspected. Across 58 files and
794,838 expanded bytes there were no `.env` files or paths, private keys, bearer
tokens, password-bearing database URLs, GitHub tokens, or formatted/canonical
document values. The only 11-digit match was the expected GitHub Run ID in safe
hosted metadata. The Node 20 action-runtime deprecation annotation is
informational: GitHub forced those pinned actions to Node 24 and every required
job still passed.

Machine-readable results are in
[`evidence/verification-summary.json`](evidence/verification-summary.json) and
[`evidence/hosted-verification.json`](evidence/hosted-verification.json).

## 10. Acceptance criteria

| Criterion | Status   | Implementation evidence                                                  |
| --------- | -------- | ------------------------------------------------------------------------ |
| P1-AC-001 | PASS     | scope manifest and zero-violation boundary report                        |
| P1-AC-002 | PASS     | module/layer checker and negative fixtures                               |
| P1-AC-003 | PASS     | ADR-011/012, schema, domain tests                                        |
| P1-AC-004 | PASS     | UUIDv7 integration assertions                                            |
| P1-AC-005 | PASS     | role-neutral base Account; no roles implemented                          |
| P1-AC-006 | PASS     | exhaustive Account transition matrix                                     |
| P1-AC-007 | PASS     | exhaustive separate lifecycle matrices and SQL denials                   |
| P1-AC-008 | PASS     | required atomic transition evidence row/outbox assertions                |
| P1-AC-009 | PASS     | terminal/release domain and SQL denials                                  |
| P1-AC-010 | PASS     | exact normalization vectors and 500-iteration property-style test        |
| P1-AC-011 | PASS     | distinct result types and format-only activation denial                  |
| P1-AC-012 | PASS     | exact HMAC vector                                                        |
| P1-AC-013 | PASS     | scope/key/value/separator/encoding mutation matrix                       |
| P1-AC-014 | PASS     | HMAC uniqueness; no plaintext/plain digest persistence                   |
| P1-AC-015 | PASS     | AES-GCM vector and complete tampering matrix                             |
| P1-AC-016 | PASS     | purpose-separated key ports and secret/schema scans                      |
| P1-AC-017 | PASS     | concurrent HMAC rotation and verified KEK rewrap drills                  |
| P1-AC-018 | PASS     | redaction, no-echo, event, and secret scans                              |
| P1-AC-019 | PASS     | immutable checksums and clean/repeat/down/up verification                |
| P1-AC-020 | PASS     | PostgreSQL cardinality/activation constraints                            |
| P1-AC-021 | PASS     | blocking partial unique index and collision tests                        |
| P1-AC-022 | PASS     | seven-checkpoint rollback matrix with zero orphans                       |
| P1-AC-023 | PASS     | real PostgreSQL 50-by-10 result                                          |
| P1-AC-024 | PASS     | same/concurrent/expired/malicious/rotation replay matrix                 |
| P1-AC-025 | PASS     | physical runtime-role negative matrix                                    |
| P1-AC-026 | PASS     | equal public shape/size/status and no entity ID                          |
| P1-AC-027 | PASS     | safe diagnostics and restricted-value scans                              |
| P1-AC-028 | PASS     | versioned Foundation Problem Details compatibility                       |
| P1-AC-029 | DEFERRED | complete inventory exists; production governance approval pending        |
| P1-AC-030 | DEFERRED | retention/legal approval and production deletion drill pending           |
| P1-AC-031 | PASS     | 17-threat executable/control/blocker mapping                             |
| P1-AC-032 | PASS     | required unit/property/crypto/lifecycle suites pass                      |
| P1-AC-033 | PASS     | real PostgreSQL constraints/grants/rollback/concurrency/rotation pass    |
| P1-AC-034 | PASS     | ADR-011/012 accepted and linked                                          |
| P1-AC-035 | PASS     | clean uncached gate plus hosted run `34662427613` and required gate pass |
| P1-AC-036 | DEFERRED | independent adversarial/final audit is separately authorized work        |

Summary:

```text
PASS:           33
FAIL:            0
DEFERRED:        3
NOT APPLICABLE:  0
```

The authoritative per-criterion record is
[`evidence/acceptance-criteria.json`](evidence/acceptance-criteria.json).

## 11. ADRs

- [ADR-011 — Account/person identity model](../../adr/ADR-011-account-person-identity-model.md)
- [ADR-012 — National identity protection and key rotation](../../adr/ADR-012-national-identity-protection-and-key-rotation.md)

The ADR register links both documents. Prior ADR text was not rewritten.

## 12. Known limitations and remaining decisions

### Engineering

Production KMS/HSM, workload identity, key custodians, monitoring, break-glass,
rotation/compromise SLOs, final repository query tuning, and production backfill
batch sizing remain undecided. The safe default is no production key or
decryption access.

### Product

Pending-reservation expiry, malicious lockout recovery, corrections, disputes,
reviewer policy, governed closed-account reactivation, and future role attachment
policy remain undecided. Claims are not released and `CLOSED` remains terminal.

### Legal/regulatory

Lawful basis, notice/consent, minimum age/jurisdiction, retention, legal holds,
data-subject workflows, evidence deletion, backup expiry, and an authoritative
cédula structural/checksum source require approval. The safe default is no real
identity collection and no claim that formatting equals verification.

### Provider

Verification provider/methods, assurance levels, minimized evidence boundary,
webhook authenticity, availability behavior, and production KMS/HSM remain
unselected. Provider-neutral ports and metadata/reference-only synthetic
evidence are the only delivered behavior.

## 13. Historical integrity and next state

The Phase 0 documentation tree and migrations `0001` through `0004` have no diff
from the published Phase 1 PLAN baseline. Phase 0 remains closed.

The implementation, evidence, and minimum hosted-harness fix were published by
normal fast-forward pushes after explicit authorization. Hosted run
`34662427613` passed on the final implementation commit, including its required
gate. P1-AC-035 is therefore PASS. P1-AC-029, P1-AC-030, and P1-AC-036 remain
DEFERRED; no adversarial audit has started and Phase 1 is not closed.

```text
PHASE 1 IMPLEMENTATION — COMPLETE
PHASE 1 — NOT CLOSED
NEXT: HUMAN AUTHORIZATION OF PHASE 1 ADVERSARIAL AUDIT
```
