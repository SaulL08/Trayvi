# Phase 1 — Accounts and Identity — Adversarial Audit

## Authoritative decision

```text
PHASE 1 ADVERSARIAL AUDIT — FAIL
PHASE 1 — NOT CLOSED
```

This audit is independent of the implementation report. It records five
unremediated blocking findings. No product code, migration, historical report,
or Phase 0 evidence was changed, and no Phase 2 work was started.

## Target

```text
Commit:      d2ec8f2b2e79a413bec2b953da81c259984bb141
Tree:        b86fa9742f3f8eb25de0934ebc44629b1a18039b
origin/main: d2ec8f2b2e79a413bec2b953da81c259984bb141
GitHub main: d2ec8f2b2e79a413bec2b953da81c259984bb141
Baseline:    CLEAN
```

The audit began only after fetching and confirming that local `HEAD`,
`origin/main`, and GitHub `main` were identical to the authorized target. The
original implementation manifest's ten hashes also match the current files.

## Environment

```text
Host:       Microsoft Windows 10.0.26200
Node:       v22.14.0
pnpm:       11.25.0
PostgreSQL: 17.11, ephemeral hardened container
PostGIS:    3.5.7
Image:      trayvi/postgis:17-3.5-alpine-hardened
Data:       synthetic only
```

The adversarial database probe creates and drops a disposable database and a
physical restricted runtime login. It emits no submitted document value,
fingerprint, envelope byte, key byte, password, or database URL.

## Audit scope

The audit reviewed the complete Phase 1 delta from plan baseline
`56e0065f8eee35f79e819455564e0e9ab3dec7db` through the implementation and final
documentation commit. It covered:

- Accounts and Identity domain/application/infrastructure boundaries;
- normalization, HMAC fingerprinting, envelope encryption, AAD, key separation,
  HMAC rotation, and KEK rewrap;
- enrollment concurrency, idempotency, duplicate safety, and atomic rollback;
- account, identity, document, claim, verification-case, evidence, and review
  lifecycles;
- a physical `trayvi_runtime` login, DDL/escalation/restricted-read attempts,
  manufactured history/evidence, and `search_path` safety;
- migrations `0005` through `0007`, their down guards, catalog privileges, and
  preservation of migrations `0001` through `0004`;
- privacy inventory, threat mapping, outbox/log/artifact leakage, scope creep,
  architecture boundaries, hosted evidence, and a detached fresh checkout;
- every acceptance criterion `P1-AC-001` through `P1-AC-036`.

The retained probe is
[`phase-one-adversarial.probe.ts`](evidence/audit/probes/phase-one-adversarial.probe.ts).
Its minimized result is
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json).

## Findings summary

```text
Critical:       0
High:           2
Medium:         3
Low:            0
Informational:  0
```

| ID         | Severity | Finding                                                               | Blocking | Affected AC        |
| ---------- | -------- | --------------------------------------------------------------------- | -------- | ------------------ |
| P1-AUD-001 | High     | Runtime can manufacture evidence/history and activate without outbox  | Yes      | 008, 025, 031, 033 |
| P1-AUD-002 | High     | Disjoint old/new HMAC writers create two aggregates for one document  | Yes      | 017, 031, 033      |
| P1-AUD-003 | Medium   | Review and transition can consume evidence from another case/identity | Yes      | 007, 008, 031, 033 |
| P1-AUD-004 | Medium   | Cross-purpose raw key reuse is accepted without detection             | Yes      | 016, 031           |
| P1-AUD-005 | Medium   | Rotation has no executable least-privilege database principal         | Yes      | 017, 025, 033      |

The Medium findings are blocking because each breaks a material mandatory
Phase 1 invariant or invalidates required evidence, not because of a numeric
threshold alone.

## Finding details

### P1-AUD-001 — Runtime can manufacture a trusted lifecycle

**Severity:** High — blocking

**Reproduction.** On a clean migrated database, the probe created a physical
login that inherits only `trayvi_runtime`. It used the application's normal path
to create a pending aggregate. The runtime login then inserted a synthetic
verification case, evidence, `NOT_REQUIRED` review, identity transition, and
account transition; it updated the case, claim, identity, and account; and it
forced all deferred constraints before commit.

Observed result:

```text
Transaction:                COMMITTED
Account:                    ACTIVE
Identity:                   ESTABLISHED
Claim:                      BOUND
Activation outbox before:   0
Activation outbox after:    0
```

**Violated invariant.** Status changes must occur through guarded commands;
the source of an authorized actor/evidence must not be self-assertable by the
general runtime; and material establishment/activation must emit their outbox
events atomically.

**Cause.** The role has enough independent `INSERT` and column-level `UPDATE`
grants to manufacture every row checked by the deferred triggers. The triggers
validate row shape and presence, but not trusted provenance, policy authority,
or the required outbox side effects. The existing negative test attempts a
lifecycle update without first manufacturing the matching history/evidence, so
it proves only that incomplete writes fail.

**Impact.** Any process or intruder holding the normal runtime database
credential can establish an unverified identity, activate its account, forge a
plausible audit chain, and suppress the expected integration events. The same
primitive permits other syntactically legal material transitions.

**Affected AC:** `P1-AC-008`, `P1-AC-025`, `P1-AC-031`, `P1-AC-033`.

**Evidence:** `runtimeManufacturedLifecycle` in
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json).

### P1-AUD-002 — HMAC rotation split-brain bypasses uniqueness

**Severity:** High — blocking

**Reproduction.** The independent control batch submitted one synthetic
document through 120 operations using one aligned HMAC key set. It produced one
winner and 119 generic conflicts. A second 120-operation batch alternated two
otherwise equivalent writers: one knew only the old key/version and one knew
only the new key/version.

Observed result:

```text
Aligned set:       1 COMPLETED, 119 CONFLICT
Disjoint sets:     2 COMPLETED, 118 CONFLICT
Winning versions:  fingerprint-audit-v1, fingerprint-audit-v2
```

**Violated invariant.** Every writer during rotation must compute a common
complete active key set; a missing version must fail closed; and one canonical
document must not create two accounts/identities.

**Cause.** Active key membership is process-local configuration. There is no
shared rotation epoch/generation or database guard that proves every writer has
the required set. Because key version is part of the partial unique index, two
disjoint writers generate non-colliding unique-index keys.

**Impact.** A rolling deployment, stale instance, premature key retirement, or
configuration split-brain can create duplicate person/account aggregates during
the exact window rotation is intended to protect.

**Affected AC:** `P1-AC-017`, `P1-AC-031`, `P1-AC-033`.

**Evidence:** `concurrency.disjointRotationKeySets` in
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json).

### P1-AUD-003 — Cross-case evidence can establish another identity

**Severity:** Medium — blocking because it breaks evidence binding

**Reproduction.** The probe created two pending identities and two verification
cases. It attached evidence only to the source case, created the target case's
`NOT_REQUIRED` review with the source evidence ID, verified the target case, and
established/activated the target identity/account.

Observed result:

```text
Cross-case review insert:   COMMITTED
Review case = evidence case: false
Target account:             ACTIVE
```

**Violated invariant.** Review and transition evidence must justify the same
verification case and identity whose state is being established.

**Cause.** `identity_reviews.case_id` and
`identity_reviews.evidence_reference` have independent foreign keys, but no
composite constraint or trigger requires the referenced evidence to belong to
the review's case. The establishment trigger joins the verified case to its
review but does not join or validate `verification_evidence`.

**Impact.** Evidence collected for one person/case can be reused to justify a
different identity, corrupting both verification integrity and the immutable
audit trail.

**Affected AC:** `P1-AC-007`, `P1-AC-008`, `P1-AC-031`, `P1-AC-033`.

**Evidence:** `crossCaseEvidence` in
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json).

### P1-AUD-004 — Key-purpose separation is not enforced

**Severity:** Medium — blocking because `P1-AC-016` is mandatory

**Reproduction.** The probe passed one 256-bit raw buffer simultaneously to a
fingerprint keyring, the KEK provider, and the idempotency committer, then
protected a synthetic document. Construction and protection succeeded.

**Violated invariant.** Fingerprint HMAC, encryption KEK, per-record DEK, and
idempotency integrity keys must have distinct purposes and key material; reuse
between purposes must be rejected or detected.

**Cause.** Each adapter validates its own key length/version and the fingerprint
keyring rejects reuse only between fingerprint versions. No composition-level
identity/material check spans the three key purposes.

**Impact.** A configuration error can collapse cryptographic isolation, expand
the blast radius of one compromise, and make purpose-specific rotation or
revocation unsafe without any startup failure or audit signal.

**Affected AC:** `P1-AC-016`, `P1-AC-031`.

**Evidence:** `keyPurposeSeparation` in
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json).

### P1-AUD-005 — Rotation lacks a least-privilege database role

**Severity:** Medium — blocking because required rotation evidence is not
executable under the declared privilege model

**Reproduction.** Catalog review found only `trayvi_migrator` and
`trayvi_runtime`. A physical runtime login correctly failed restricted envelope
and fingerprint reads and a wrapped-DEK/KEK update. No rotation/crypto worker
role exists. The retained PostgreSQL rotation tests construct their pool from
the administrative migration URL, so they execute as database owner rather than
as a declared rotation workload.

**Violated invariant.** HMAC backfill and KEK rewrap must execute through a
purpose-bound least-privilege workload, and the runtime/migration/worker grant
matrix must be proven independently.

**Cause.** Rotation adapters were implemented, but their database principal and
minimum grants were not. The only demonstrated full execution uses the database
owner/administrator connection.

**Impact.** Operational rotation is either unusable, must run with excessive
migration privileges, or requires widening the general runtime role and thereby
weakening the restricted-column boundary.

**Affected AC:** `P1-AC-017`, `P1-AC-025`, `P1-AC-033`.

**Evidence:** `privileges` in
[`adversarial-probes.json`](evidence/audit/adversarial-probes.json) and the
reviewed role/grant definitions in bootstrap plus migrations `0005`-`0007`.

## Identity uniqueness

`do-cedula-v1` preserves leading zeroes, rejects malformed Unicode and
confusables, removes only the approved ASCII characters, requires exactly 11
ASCII digits, and is idempotent. Formatting remains distinct from structural
assessment and trusted verification.

The normal aligned-key path is database-authoritative: 120 same-document
operations produced one aggregate and 119 safe conflicts. Country, issuer,
document type, normalization profile, key version, and HMAC value are included
in the fingerprint/index scope. Nevertheless, identity uniqueness fails under
the rotation split-brain condition in `P1-AUD-002`.

## Crypto and offline oracle

The HMAC byte contract and published vector pass. Plain SHA-256/document
plaintext are not stored as the equality mechanism, and the runtime cannot read
fingerprint bytes. A database-only dump therefore does not expose a direct
offline equality oracle without the external HMAC key.

AES-256-GCM, AAD field binding, wrong-key/missing-key behavior, ciphertext/tag/
nonce/AAD tampering, and controlled plaintext/DEK buffer clearing pass their
tests. No real key material is in the repository or audit evidence. Cross-purpose
key material reuse remains unguarded as `P1-AUD-004`.

## Rotation

The backfill and rewrap algorithms are resumable and idempotent under their
tested owner connection; corrupt aliases and wrong KEKs fail closed; ciphertext
does not change during rewrap. These positive results do not overcome:

- two winners when old-only and new-only writers coexist (`P1-AUD-002`); and
- absence of an executable least-privilege rotation principal (`P1-AUD-005`).

No promotion or retirement is safe until both conditions are remediated and
re-audited.

## Concurrency, replay, and atomicity

Positive evidence:

- hosted implementation: 10 rounds × 50 attempts = 10 winners and 490 safe
  conflicts;
- independent aligned-key batch: 120 attempts = 1 winner and 119 conflicts;
- independent same-operation replay: 120 calls = 1 completed aggregate;
- mismatched replay mutates nothing;
- all seven mutation checkpoints roll back without partial aggregates or orphan
  outbox/transition rows.

The hostile disjoint-key batch is the blocking exception. The regular creation
unit of work itself remains atomic.

## Lifecycles and evidence

Domain state matrices and terminal non-reopening tests pass. Direct incomplete
SQL updates also fail as intended. The stronger manufactured-history probe,
however, succeeds, and cross-case evidence is accepted. These are material
failures of provenance, evidence coherence, and atomic audit-event guarantees.

Retention, abandonment, closure, crypto-erasure, legal holds, evidence deletion,
and backup expiry remain explicit pre-production governance work under
`P1-AC-029` and `P1-AC-030`; the audit does not invent those policies.

## Runtime privileges and `search_path`

Positive denials with a physical runtime login:

```text
Restricted ciphertext SELECT: DENIED
Restricted fingerprint SELECT: DENIED
Document KEK rewrap UPDATE:    DENIED
DDL in Accounts schema:        DENIED
SET ROLE trayvi_migrator:      DENIED
```

Identity lifecycle trigger functions explicitly set `search_path` to
`pg_catalog, pg_temp`. Although the login default is `"$user", public`, the
runtime cannot create a user schema or shadow objects in `public`; no trigger
shadowing path was reproduced.

The manufactured-lifecycle success and missing rotation role make the overall
privilege result a FAIL despite the positive restricted-read/DDL/escalation
denials.

## Anti-enumeration

New and duplicate conceptual submissions have the same safe public code, next
step, schema, serialized size class, and no existing account/identity ID. The
duplicate transaction rolls back before recording only a generic operation
conflict. Phase 1 intentionally exposes no HTTP enrollment endpoint, so HTTP
headers, redirects, status timing, and network timing are not applicable in this
phase and must be measured when a transport is separately authorized.

## Privacy and leakage

All 115 Phase 1 columns have an inventory entry. Inventory approval and final
retention/legal policy correctly remain deferred. Repository secret scan,
redaction/error tests, outbox allowlist review, and downloaded hosted artifacts
contained no raw/formatted document, fingerprint, envelope bytes, key material,
credential-bearing database URL, private key, or GitHub token. The sole
11-digit artifact match was the allowed hosted run ID.

Machine evidence is in
[`scope-privacy-migrations.json`](evidence/audit/scope-privacy-migrations.json).

## Migrations

Migrations `0001` through `0004` and all Phase 0 documentation are unchanged.
The recorded SHA-256 values for `0005` through `0007` match the implementation
evidence. Clean apply, repeat no-op, empty three-down/three-up, populated down
refusal, invalid-migration rollback, and concurrent migration serialization
pass. No migration was amended by this audit.

The schema defects in `P1-AUD-001` and `P1-AUD-003`, and the missing role in
`P1-AUD-005`, require forward remediation; this report does not edit applied
migrations.

## Architecture and scope

The boundary checker reports zero violations. The 60-file implementation delta
contains no Phase 2 credential, authentication, recovery, role, marketplace,
booking, messaging, payment, or logistics feature. No Phase 0 file or migration
`0001`-`0004` changed. The audit itself adds only this report and safe evidence/
probe files under the authorized audit path.

## Hosted evidence

Implementation run `34662427613` at
`b0375079e90d75482e7aa477492ddc3437e8f431` is terminal SUCCESS:

```text
Quality:       SUCCESS (job 103467503983)
Integration:   SUCCESS (job 103467503839)
Security:      SUCCESS (job 103467503926)
Required gate: SUCCESS (job 103467857764)
```

Final documentation run `34663017247` at the exact target commit is also terminal
SUCCESS:

```text
Quality:       SUCCESS (job 103469273883)
Integration:   SUCCESS (job 103469273912)
Security:      SUCCESS (job 103469273798)
Required gate: SUCCESS (job 103469691469)
```

The implementation run's three artifacts were downloaded and independently
scanned: 58 files, 794838 expanded bytes, 128/128 hosted unit tests, 31/31 hosted
integration tests, zero dependency advisories, and zero Trivy high/critical
findings. Artifact IDs/digests and inspection counts are preserved in
[`hosted-verification.json`](evidence/audit/hosted-verification.json).

Hosted success proves the committed gates ran; it does not cover the stronger
adversarial cases that produced the five findings.

## Fresh checkout

A new detached worktree at the exact target used a fresh `node_modules`, frozen
lockfile installation, `TURBO_FORCE=true`, the hardened ephemeral database, and
no development-tree build artifacts. It remained clean and produced:

```text
Toolchain:             PASS
Format:                PASS
Lint:                  PASS
Typecheck:             12/12 PASS, 0 cached
Architecture:          PASS, 0 violations
Secret scan:           PASS, 0 findings
License scan:          PASS, 267 packages, 0 findings
Unit:                  127 passed, 1 platform skip, 0 failed
Build:                 7/7 PASS, 0 cached
Integration:           29 passed, 2 platform skips, 0 failed
Database verification: 14/14 PASS
Dependency registry:   INFRASTRUCTURE_UNAVAILABLE
```

The dependency audit was attempted twice and the registry returned `fetch
failed`, so the local `verify:full` process ended nonzero after all other gates
passed. This is classified as external infrastructure, not a product regression:
the exact target's hosted security job is successful and its downloaded,
machine-readable dependency report contains zero advisories. The earlier
authoritative fresh implementation run also passed the complete dependency gate.

Details are in
[`verification-summary.json`](evidence/audit/verification-summary.json).

## Acceptance Criteria

```text
PASS:      26
FAIL:       7
DEFERRED:   2
PENDING:    1
```

| Criterion | Status   | Audit conclusion                                                       |
| --------- | -------- | ---------------------------------------------------------------------- |
| P1-AC-001 | PASS     | scope limited to Phase 1 and approved seams                            |
| P1-AC-002 | PASS     | architecture boundary gate clean                                       |
| P1-AC-003 | PASS     | owned concepts remain distinct                                         |
| P1-AC-004 | PASS     | exposed entity/evidence IDs are opaque UUIDv7                          |
| P1-AC-005 | PASS     | base Account remains role-neutral; no role feature                     |
| P1-AC-006 | PASS     | domain Account edge/terminal matrix passes                             |
| P1-AC-007 | FAIL     | cross-case/cross-identity evidence combination accepted                |
| P1-AC-008 | FAIL     | manufactured lifecycle commits without required activation outbox      |
| P1-AC-009 | PASS     | terminal reopening and silent claim release denied                     |
| P1-AC-010 | PASS     | exact normalization contract/property checks pass                      |
| P1-AC-011 | PASS     | formatting/assessment/verification remain distinct                     |
| P1-AC-012 | PASS     | exact HMAC vector passes                                               |
| P1-AC-013 | PASS     | HMAC scope/key/value/encoding mutations separate                       |
| P1-AC-014 | PASS     | no plaintext/unkeyed uniqueness digest persisted                       |
| P1-AC-015 | PASS     | envelope/AAD vector and tamper denials pass                            |
| P1-AC-016 | FAIL     | cross-purpose raw key reuse accepted                                   |
| P1-AC-017 | FAIL     | rotation split-brain duplicate plus missing rotation role              |
| P1-AC-018 | PASS     | logs/errors/events/artifacts contain no restricted material            |
| P1-AC-019 | PASS     | immutable migration/down/up behavior passes                            |
| P1-AC-020 | PASS     | literal one-identity and activation state prerequisites enforced       |
| P1-AC-021 | PASS     | every declared blocking alias is covered by the partial index          |
| P1-AC-022 | PASS     | aggregate/idempotency/outbox failure injection remains atomic          |
| P1-AC-023 | PASS     | 10x50 hosted and independent aligned 120-way race each have one winner |
| P1-AC-024 | PASS     | replay/mismatch/expiry commitments behave safely                       |
| P1-AC-025 | FAIL     | runtime manufactured lifecycle; rotation privilege matrix incomplete   |
| P1-AC-026 | PASS     | conceptual new/duplicate public outcome remains indistinguishable      |
| P1-AC-027 | PASS     | diagnostics distinguish safe causes without restricted values          |
| P1-AC-028 | PASS     | stable Problem Details mapping; no Phase 2 contract                    |
| P1-AC-029 | DEFERRED | pre-production privacy/retention governance approval                   |
| P1-AC-030 | DEFERRED | pre-production closure/erasure/tombstone/backup policy                 |
| P1-AC-031 | FAIL     | adversarial probes invalidate claimed threat controls                  |
| P1-AC-032 | PASS     | unit/property suites pass                                              |
| P1-AC-033 | FAIL     | real PostgreSQL disproves privilege/rotation/evidence claims           |
| P1-AC-034 | PASS     | ADR-011/012 and register integrity pass                                |
| P1-AC-035 | PASS     | authoritative fresh/hosted gates remain valid                          |
| P1-AC-036 | PENDING  | audit failed; remediation plus re-audit required                       |

The authoritative per-criterion reasons and finding links are in
[`acceptance-criteria.json`](evidence/audit/acceptance-criteria.json).

## Documentation

Audit outputs are intentionally limited to:

- this `AUDIT.md`;
- safe JSON evidence under `evidence/audit/`; and
- the deliberately retained synthetic adversarial probe under
  `evidence/audit/probes/`.

The audit did not modify `PLAN.md`, `IMPLEMENTATION.md`, ADRs, historical
evidence, application code, tests, or migrations. The evidence manifest is
[`manifest.json`](evidence/audit/manifest.json).

## Final decision

```text
PHASE 1 ADVERSARIAL AUDIT — FAIL
PHASE 1 — NOT CLOSED
```

Required next state:

```text
AWAITING EXPLICIT HUMAN AUTHORIZATION FOR PHASE 1 REMEDIATION
```

No remediation is performed in this audit. Phase 2 remains unauthorized and was
not started.
