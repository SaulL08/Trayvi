# Phase 1 — Adversarial Audit Remediation

**Status:** READY FOR PHASE 1 RE-AUDIT  
**Date:** 2026-09-24  
**Original audit target:** `d2ec8f2b2e79a413bec2b953da81c259984bb141`  
**Original audit evidence commit:** `665ff85`  
**Remediation code head:** `4e05d54`  
**Authorization:** Phase 1 remediation explicitly authorized by the repository collaborator on
2026-09-24, as required by the audit's `AWAITING EXPLICIT HUMAN AUTHORIZATION` state  
**Scope:** P1-AUD-001 through P1-AUD-005 only; Phase 2 remains unauthorized and was not started

The original [AUDIT.md](AUDIT.md), [PLAN.md](PLAN.md), [IMPLEMENTATION.md](IMPLEMENTATION.md), all
`evidence/*.json` files (including the hash-pinned `data-inventory.json`), the audit evidence under
`evidence/audit/`, and migrations `0001` through `0007` are unchanged. This document records the
corrective commits and post-fix probes. It does not perform or claim the independent Phase 1
re-audit.

## Closure register

| Finding    | Original severity | Fix commit(s) | Local retest | Status |
| ---------- | ----------------- | ------------- | ------------ | ------ |
| P1-AUD-001 | High              | `647ceba`     | PASS         | FIXED  |
| P1-AUD-002 | High              | `128c6d7`     | PASS         | FIXED  |
| P1-AUD-003 | Medium            | `647ceba`     | PASS         | FIXED  |
| P1-AUD-004 | Medium            | `4413317`     | PASS         | FIXED  |
| P1-AUD-005 | Medium            | `4e05d54`     | PASS         | FIXED  |

## Finding records

### P1-AUD-001 — Runtime can manufacture a trusted lifecycle

- **Root cause:** `trayvi_runtime` held independent `INSERT` and column `UPDATE` grants on every row the
  deferred guards inspected, and the guards validated row shape and presence rather than provenance or
  the required outbox side effect.
- **Fix/files:** Migration `0008_identity_lifecycle_command_boundary` revokes the runtime's lifecycle
  writes (account/identity status, claim binding, verification cases, evidence, reviews). Row-level
  security limits runtime transition-history inserts to the initial enrollment row. Establishment and
  activation run only through `identity.record_trusted_verification`, a `SECURITY DEFINER` command
  owned by the non-login `trayvi_lifecycle_owner` and executable only by the new
  `trayvi_verification` workload role. The command writes case, evidence, review, both transitions,
  and both activation outbox events in one transaction. Deferred guards now run as the command owner.
  `PostgresPhaseOneStore.recordTrustedVerification` calls the command. Bootstrap adds both roles.
- **Original probe:** The runtime login committed `ACTIVE`/`ESTABLISHED`/`BOUND` with zero activation
  events.
- **Post-fix probe:** `runtimeManufacturedLifecycle.committed = false`; the aggregate remains
  `PENDING_IDENTITY`/`PENDING`/`RESERVED` with zero activation events. A new integration test uses
  physical runtime and verification logins: every forged link fails with `42501`, the runtime cannot
  execute the command, and the verification login records, replays, and rejects decision reuse with
  exactly one `identity.established` and one `account.activated` event.

### P1-AUD-002 — HMAC rotation split-brain bypasses uniqueness

- **Root cause:** The active HMAC key set was process-local configuration. Because the blocking unique
  index includes the key version, writers with disjoint key sets could never collide.
- **Fix/files:** Migration `0009_fingerprint_key_policy` adds `identity.fingerprint_key_policy`, a
  single non-secret row naming the key versions every new document must be fingerprinted under. A
  deferred `SECURITY DEFINER` trigger rejects any document missing a required version and rejects all
  enrollment while no policy exists. `identity.set_fingerprint_key_policy` accepts only a non-empty,
  valid set that every blocking document already covers, so a version cannot be retired before
  backfill. The writer check holds `FOR SHARE` and the policy change `FOR UPDATE`, serializing policy
  changes against in-flight writers. Key material stays in external configuration, as PLAN §8.2
  requires.
- **Original probe:** Disjoint writers produced 2 `COMPLETED` aggregates.
- **Post-fix probe:** 1 `COMPLETED`, 59 `CONFLICT`, 60 fail-closed rejections; `winnerCount = 1`. The
  integration suite adds a 60-writer disjoint regression and runs the full
  require-both → backfill-all → retire protocol before the post-cutover writer.

### P1-AUD-003 — Cross-case evidence can establish another identity

- **Root cause:** `identity_reviews.case_id` and `identity_reviews.evidence_reference` had independent
  foreign keys, and the establishment guard never joined the evidence.
- **Fix/files:** Migration `0008` adds `verification_evidence (id, case_id)` uniqueness and the
  composite foreign key `identity_review_evidence_same_case`. `require_establishment_evidence` also
  requires the establishing transition to cite evidence of the identity's own verified, reviewed case.
- **Original probe:** The cross-case review committed and the target account became `ACTIVE`.
- **Post-fix probe:** `crossCaseEvidence.committed = false`. The integration suite shows that even the
  table owner cannot insert a cross-case review.

### P1-AUD-004 — Key-purpose separation is not enforced

- **Root cause:** Each adapter validated only its own keys; no composition-level check spanned the
  fingerprint, KEK, and idempotency purposes.
- **Fix/files:** Fingerprint keyrings, KEK providers, and request committers implement
  `KeyMaterialIdentified` and expose domain-separated SHA-256 identities of their key material. The
  keys themselves never leave the adapter. `NodeIdentityDocumentProtector` refuses construction on any
  cross-purpose match, including retired fingerprint keys, and `computeRotationAliases` applies the
  same check to rotation target keyrings. Distinct KEK versions may no longer share material.
- **Original probe:** One raw buffer was accepted for all three purposes.
- **Post-fix probe:** `sameRawKeyAcceptedAcrossFingerprintKekAndIdempotency = false`. A new unit test
  covers every purpose pair, retired keys, rotation targets, duplicate KEK versions, and confirms that
  identities never equal raw key bytes.

### P1-AUD-005 — Rotation lacks a least-privilege database role

- **Root cause:** Rotation adapters existed, but no purpose-bound principal did; tests executed them
  with the administrative migration URL.
- **Fix/files:** Bootstrap adds the NOLOGIN `trayvi_rotation` role. Migration
  `0010_rotation_workload_grants` grants only the document envelope/state columns, updates to
  `kek_key_version`/`wrapped_dek`/`updated_at`, claim insert plus `state`/`bound_at`/`tombstoned_at`
  updates, fingerprint reads for backfill verification, idempotent outbox inserts (`INSERT` plus
  `SELECT (id)` for `ON CONFLICT`), and `EXECUTE` on `set_fingerprint_key_policy`.
- **Original probe:** No rotation/worker role existed.
- **Post-fix probe:** `dedicatedRotationRolePresent = true`. Backfill, rewrap, and every key-policy change
  in the integration suite run as a physical rotation login. A pinned matrix denies account, identity,
  and verification reads; ciphertext, state, and fingerprint updates; deletes; DDL; role escalation;
  and the verification command. The runtime cannot change the key policy.

## Migrations

`0008`, `0009`, and `0010` are new, paired, and transactional. Each `up` fails fast if the required
bootstrap roles are missing. Each `down` restores the prior state and, like `0007`, refuses to run
against a populated Phase 1 domain. The clean up/down/up cycle now covers `0005` through `0010`.
Environments bootstrapped before this remediation must re-run `infra/database/bootstrap/0001_roles.sql`
(idempotent) before migrating.

## Verification state

Local macOS arm64 run at `4e05d54`, with the hardened PostGIS image under `linux/amd64` emulation:

- `corepack pnpm verify`: PASS — 129 unit tests, 12 workspace tasks, format, lint, strict types,
  architecture, secret, license, and toolchain checks.
- `test:integration:local`: PASS — 9 files, 34 tests, no skips.
- `db:verify:local`: PASS — 14/14 invariants.
- `security:dependencies`: PASS — zero advisories and zero policy violations.
- Remediation probe: all five original scenarios fail closed; see
  [adversarial-retest.json](evidence/remediation/adversarial-retest.json).

Not yet performed: hosted Linux CI and a clean checkout. The hosted PostGIS image build also needs the
`libexpat` pin update proposed separately in PR #1, because Alpine no longer serves `2.8.4-r0`.

Safe evidence is under [evidence/remediation](evidence/remediation). The retained audit probe is
unchanged. [phase-one-remediation.probe.ts](evidence/remediation/probes/phase-one-remediation.probe.ts)
is a copy that registers the fingerprint key policy and tolerates fail-closed rejections; it uses
synthetic data only. No raw environment, credential, database URL, or key material is versioned.

## Operational consequences

- Enrollment is refused until `identity.set_fingerprint_key_policy` has registered the fingerprint key
  versions for the environment. This is intentional fail-closed behavior.
- The trusted verification outcome handler and key rotation require logins that are members of
  `trayvi_verification` and `trayvi_rotation`, respectively; the general runtime login can do neither.
- The new `identity.fingerprint_key_policy` table is inventoried in
  [data-inventory-addendum.json](evidence/remediation/data-inventory-addendum.json), because the
  original inventory is hash-pinned; the privacy-inventory test reads both files.

## Acceptance criteria and next gate

The seven criteria that failed in the audit (`P1-AC-007`, `008`, `016`, `017`, `025`, `031`, `033`) are
addressed by the fixes above and are **PENDING RE-AUDIT**. `P1-AC-029` and `P1-AC-030` remain
**DEFERRED** to pre-production governance. `P1-AC-036` remains **PENDING** until an independent
re-audit challenges the final commit.

Current maximum status: **READY FOR PHASE 1 RE-AUDIT**.
