# Phase 0 — Adversarial Audit Remediation

**Status:** REMEDIATION IMPLEMENTED AND LOCALLY VERIFIED — HOSTED CI PENDING  
**Date:** 2026-09-06  
**Original audit target:** `6b977aa4eb078f4079cb24cbd1370244d31c7e17`  
**Original audit evidence commit:** `2d2db6d`  
**Scope:** P0-AUD-001 through P0-AUD-011 only; Phase 1 remains unauthorized

The original [AUDIT.md](AUDIT.md) and its three evidence files remain unchanged. This document records
the corrective commits and post-fix probes. It does not perform or claim the independent Phase 0
re-audit.

## Closure register

| Finding    | Original severity | Fix commit(s)        | Local retest | Status |
| ---------- | ----------------- | -------------------- | ------------ | ------ |
| P0-AUD-001 | High              | `cbb3052`            | PASS         | FIXED  |
| P0-AUD-002 | High              | `905f532`            | PASS         | FIXED  |
| P0-AUD-003 | High              | `913769a`            | PASS         | FIXED  |
| P0-AUD-004 | Medium            | `a2949b7`            | PASS         | FIXED  |
| P0-AUD-005 | Medium            | `1f3801f`            | PASS         | FIXED  |
| P0-AUD-006 | Medium            | `042a0ab`            | PASS         | FIXED  |
| P0-AUD-007 | Medium            | `85b1611`            | PASS         | FIXED  |
| P0-AUD-008 | Medium            | `5201fa5`            | PASS         | FIXED  |
| P0-AUD-009 | Medium            | `74105b0`            | PASS         | FIXED  |
| P0-AUD-010 | Medium            | `3f291c5`, `c6c4e10` | PASS         | FIXED  |
| P0-AUD-011 | Low               | `15b825d`            | PASS         | FIXED  |

## Finding records

### P0-AUD-001 — Sensitive error text

- **Root cause:** Redaction handled sensitive object keys and token-shaped strings but not ordinary
  structured assignments embedded in error text.
- **Fix/files:** Expanded `packages/observability/src/redaction.ts`; added sanitizer, final logger, and
  safe exception-filter regressions.
- **Original probe:** Secret canary remained in the sanitized Error and final log.
- **Post-fix probe:** Password/token/authorization/secret/OTP/national-ID assignments across JSON,
  query, quoted, spaced, nested cause, and metadata forms are replaced; the final log is clean.

### P0-AUD-002 — Premature API shutdown

- **Root cause:** Response timeouts bounded the client reply but no registry represented the handler
  promise that could continue running.
- **Fix/files:** Added `apps/api/src/active-operations.ts`; integrated admission stop, handler tracking,
  deadline state, process failure, and lifecycle logs in API bootstrap/main.
- **Original probe:** All 25 handlers remained active when close resolved and `api.stopped` was logged.
- **Post-fix probe:** Normal/cancelable work drains; a non-cancelable deadline enters `FAILED`, emits
  `api.shutdown.incomplete`, omits `api.stopped`, and makes the process exit non-zero.

### P0-AUD-003 — Migration history and down-file drift

- **Root cause:** Only the applied up checksum was recorded; applied history was not required to be an
  exact prefix of local paired migrations.
- **Fix/files:** Hardened `scripts/db/migrate.ts` and added the real-PostgreSQL migration-integrity
  suite.
- **Original probe:** Version `9999` and a modified down file were accepted.
- **Post-fix probe:** Unknown/missing/gapped/incomplete metadata and either-file drift fail before SQL;
  valid prefix/no-op/down/up and controlled exact legacy-schema upgrade pass transactionally.

### P0-AUD-004 — Architecture gate bypasses

- **Root cause:** The gate compared narrow source patterns instead of resolving workspace identities,
  equivalent imports, and process aliases through the AST.
- **Fix/files:** Reworked `scripts/architecture/check-boundaries.ts` and committed invalid workspace and
  alias fixtures.
- **Original probe:** Foundation-to-app package import and aliased environment reads were missed.
- **Post-fix probe:** Package/deep/relative/re-export/dynamic imports and global/local/destructured
  environment aliases fail; the real workspace graph passes.

### P0-AUD-005 — Production database TLS

- **Root cause:** Database URLs were validated without an effective typed PostgreSQL TLS policy.
- **Fix/files:** Added `DatabaseTlsConfig`, validation, and actual `pg` options in config, API probe,
  migration runner, environment example, and unit tests.
- **Original probe:** A production plaintext PostgreSQL URL parsed successfully.
- **Post-fix probe:** Staging/production require `verify-full`; conflicting URL SSL parameters fail;
  runtime and migration pools receive certificate verification options.

### P0-AUD-006 — Escapable runtime administrator session

- **Root cause:** Local runtime authenticated as the administrator and used startup `SET ROLE`, so the
  session could restore administrator authority.
- **Fix/files:** Bootstrap now creates `trayvi_runtime_login` with an independent generated credential;
  config/API/test support and database verification authenticate directly as restricted logins.
- **Original probe:** Explicit `SET ROLE trayvi_local_admin` restored DDL.
- **Post-fix probe:** Session/current identity is the physical runtime login; DDL, role restoration,
  role administration, grants, and ownership escalation are denied.

### P0-AUD-007 — Contradictory outbox states and DELETE

- **Root cause:** Per-column checks did not encode state combinations and runtime inherited DELETE.
- **Fix/files:** Added paired migration `0002_outbox_state_integrity` plus database assertions.
- **Original probe:** Processing without a lock, pending with lock/error, and runtime DELETE passed.
- **Post-fix probe:** All four valid state shapes pass; both contradictions fail; runtime DELETE and
  its default privilege are revoked.

### P0-AUD-008 — Accessor execution in sanitizer

- **Root cause:** `Object.entries` and direct Error field reads invoked accessors and allowed reflection
  exceptions to replace the original failure.
- **Fix/files:** Descriptor-based traversal and safe reflection containment in redaction, with hostile
  getter/Error/Proxy tests through the final logger.
- **Original probe:** The getter ran once and its exception escaped.
- **Post-fix probe:** Accessors are never invoked; hostile reflection yields fixed `[ACCESSOR]` or
  `[UNSANITIZABLE]` markers and logging completes.

### P0-AUD-009 — Timeout context loss

- **Root cause:** Timeout/error/response callbacks relied only on ambient AsyncLocalStorage context.
- **Fix/files:** Added request-keyed immutable context storage and explicit IDs at exception/completion
  log boundaries; explicit supplied context takes precedence in the logger.
- **Original probe:** 0/25 failure and 0/25 completion records carried request IDs.
- **Post-fix probe:** 25 unique concurrent timeout requests preserve the exact request/correlation pair
  in response headers and both event types with no cross-request bleed.

### P0-AUD-010 — Unidentified Moderate dependency advisory

- **Root cause:** CI retained only a human count below its High threshold and had no Moderate triage
  contract.
- **Fix/files:** Added normalized audit/triage tooling and artifact metadata, recorded
  `GHSA-w5hq-g745-h8pq`, and upgraded direct production dependency `uuid` from 11.1.0 to 11.1.1.
- **Original probe:** One Moderate existed without package, range, fix, scope, owner, or assessment.
- **Post-fix probe:** The advisory is dispositioned `FIX` with full metadata and dates; post-fix audit
  reports zero vulnerabilities. High/Critical remain unconditional failures and untriaged Moderate
  findings now fail deterministically.

### P0-AUD-011 — Silent history-scan failure

- **Root cause:** A fixed 20 MiB synchronous buffer and unconditional catch treated all Git errors as
  empty history.
- **Fix/files:** Streamed `git log` incrementally, separated explicit no-history detection, propagated
  Git failures, and expanded scanner tests.
- **Original probe:** Static control flow allowed buffer exhaustion/permission errors to report pass.
- **Post-fix probe:** Empty history passes, a non-repository fails closed, more than 20 MiB streams, a
  history-only canary fails, and clean history passes.

## Verification state

- `corepack pnpm verify`: PASS — 14 unit files, 58 tests, five builds, architecture, secret, license,
  format, lint, strict types, and toolchain checks.
- `corepack pnpm test:integration:local`: PASS — 17 tests; two POSIX child-signal cases skipped on
  Windows and reserved for Linux CI.
- `corepack pnpm db:verify:local`: PASS — all 11 reported database invariants true.
- `corepack pnpm security:dependencies`: PASS — zero advisories after the `uuid` update; TLS validation
  remained enabled.
- Clean checkout at `e4b2150`: PASS — frozen install, root gate, 17 Windows integrations with two
  documented POSIX skips, and all 11 database invariants; no workspace `node_modules` or build cache
  was reused.
- Hosted Linux CI and its retained artifacts are pending the explicit push authorization required
  after automatic approval review rejected the attempted external write before execution.

Safe evidence is under [evidence/remediation](evidence/remediation). No raw environment, credential,
certificate, database dump, filesystem path, raw log, or secret canary is versioned.

## Residual risk and next gate

No known audit finding remains open in the local remediation result. AC-031 remains deferred under its
existing pre-production governance trigger. Formal Phase 0 re-audit remains a separate, unauthorized
stage and must independently challenge the final commit after hosted CI succeeds.

Current maximum status: **HOSTED CI PENDING**.
