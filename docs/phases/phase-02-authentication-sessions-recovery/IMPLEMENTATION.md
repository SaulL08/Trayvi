# Phase 2 — Authentication, Sessions, and Recovery — Implementation

Status: **SPEC-001 IMPLEMENTED ON THE INTEGRATION BRANCH; SPEC-002 AND SPEC-003 NOT STARTED**

Integration branch: `spec/001-contact-verification-challenges/integration`

SPEC-001 functional head (last stream merge): `2d5df06` (PR #12)

SPEC-001 catalog evidence commit: `ada2b86` (T-91)

This document records Phase 2 implementation as each spec lands. It is not an
adversarial audit, does not close Phase 2, and does not authorize a merge to
`main`. SPEC-001 was approved ahead of the PLAN §1 gate (see
[SPEC-001 requirements §7](specs/SPEC-001-contact-verification-challenges/requirements.md#7-approval-record)):
Phase 1 has not recorded a final `PASS` and ADR-013 is still `Proposed`, so the
integration branch stays off `main` until both hold.

| Spec                                                                                                  | Status                               | Section |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ | ------- |
| [SPEC-001](specs/SPEC-001-contact-verification-challenges/) — contact verification and OTP challenges | implemented, integration branch only | §1–§9   |
| [SPEC-002](specs/SPEC-002-sign-in-and-sessions/) — sign-in and sessions                               | not started                          | —       |
| [SPEC-003](specs/SPEC-003-account-recovery/) — account recovery                                       | not started                          | —       |

## 1. SPEC-001 delivered scope

SPEC-001 delivers proof of possession of a phone number:

- the `@trayvi/auth` module (`modules/auth`) with domain, application, and
  infrastructure layers, frozen contracts, and the `auth` schema;
- `e164-v1` phone normalization, the keyed contact fingerprint, and the
  AES-256-GCM contact envelope;
- contact points with guarded bind/replace commands and outbox events;
- OTP verification challenges, keyed OTP commitments, and single-use contact
  proofs;
- PostgreSQL rate-limit buckets keyed by HMAC subject commitments;
- a provider-neutral `OtpDeliveryPort` with a synthetic adapter and a global
  delivery budget;
- signed provider-callback ingress with receipts and the delivery-status handler;
- HTTP routes for challenge start, resend, verify, and provider callbacks.

Out of scope and absent: sign-in, sessions, tokens, passwords, registration
binding (SPEC-002), recovery, contact change, re-verification (SPEC-003), and
any real SMS/WhatsApp provider (P2-AC-039).

## 2. Work streams and merges

Each stream merged into the integration branch with a merge commit.

| Stream   | PR  | Merge     | Migration | Content                                                          |
| -------- | --- | --------- | --------- | ---------------------------------------------------------------- |
| scaffold | —   | `d38eb09` | `0012`    | Auth package, contracts, shared infra, config, empty HTTP module |
| ws-a     | #8  | `2bbbff3` | `0013`    | phone normalization, contact crypto, contact points              |
| ws-b     | #9  | `9fab42d` | `0014`    | OTP challenges and contact proofs                                |
| ws-c     | #10 | `4d0a5f8` | `0015`    | rate limiting and subject commitments                            |
| ws-d     | #11 | `87be562` | `0016`    | delivery port, signed callbacks, delivery-status handler         |
| ws-e     | #12 | `2d5df06` | —         | HTTP routes, composition, oracle and leak tests                  |

Integration-owned commits outside the streams:

- `d87bbcf` renumbers Phase 2 migrations by +1 (`0011` belongs to issue #6) and
  records the early approval.
- `1c64e8f`, `60ca288` derive migration counts from the files on disk, so streams
  add migrations without editing integration-owned tests.
- `b5baac6` runs integration test files serially; parallel suites exceeded
  PostgreSQL `max_connections`.
- `74169e4` is the integration amendment: `HTTP_TRUSTED_PROXY_HOPS`,
  `loadAuthConfig()`, Nest `rawBody`, and `AuthHttpModule.register(...)`.
- `ada2b86` adds the Auth catalog to `db:verify` (T-91).

## 3. Database delivery

| Migration                           | Objects                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `0012_auth_schema`                  | `auth` schema; `USAGE` for the runtime role                                                         |
| `0013_auth_contact_points`          | contact points, fingerprint aliases, transitions; guarded `bind/replace_primary_contact`            |
| `0014_auth_verification_challenges` | challenges and contact proofs; counter checks; state-edge trigger                                   |
| `0015_auth_rate_limit_buckets`      | rate-limit buckets keyed by `(dimension, subject, window_start)`                                    |
| `0016_auth_provider_callbacks`      | callback receipts with `UNIQUE (provider_alias, kind, provider_event_id)`; delivery-status function |

Migrations `0001`–`0011` are unchanged. Every new migration has a down file that
refuses to run while its tables hold rows.

PostgreSQL enforces:

- one `ACTIVE` contact per `(channel, profile, key_version, fingerprint)` and one
  `ACTIVE` primary contact per account (partial unique indexes);
- contact state changes only through `SECURITY DEFINER` functions owned by
  `trayvi_lifecycle_owner` with a fixed `search_path`;
- only the PLAN §5.3 challenge edges (trigger), bounded counters, and a single
  `consumed_at` per proof;
- 32-byte `bytea` fingerprints, commitments, and subjects; no plain phone, IP, or
  OTP column exists.

`db:verify` applies `0001`–`0016` to a clean database, checks the Auth catalog
(tables, partial unique indexes, definer functions, and the exact table, column,
and `EXECUTE` privileges of `trayvi_runtime`), rolls back `0016`→`0012` until
the `auth` schema is gone, rolls forward, and checks again. A deliberately wrong
expected grant makes it fail. Transcript:
[`evidence/spec-001/db-verify.json`](evidence/spec-001/db-verify.json).

## 4. Security properties

- **OTP:** 6 digits by rejection sampling from a CSPRNG; only the PLAN §8.1 keyed
  commitment is stored and compared in constant time.
- **Brute force:** attempt cap, resend cap, cooldown, contact failure budget, and
  the PLAN §11 dimensions. The one-day simulation for one number admits at most
  10 guesses (probability ≤ 10 / 10⁶).
- **Enumeration:** challenge start reads no account or binding state.
  Contact-limited starts return the same `202` envelope and send nothing; only
  network and installation limits return `RATE_LIMITED`. The oracle test takes
  200 samples per class (registered, unregistered, contact-limited) and requires
  equal status, schema, headers, and size class, with a median timing spread
  under 20 ms.
- **SMS pumping:** global delivery budget through the rate limiter; a failed or
  over-budget delivery still returns the generic envelope, records a safe outcome
  code, and never resends the same code.
- **Callbacks:** size, signature, and timestamp are checked before parsing; an
  unknown alias, a bad signature, or a stale timestamp get one identical
  `401 CALLBACK_REJECTED`; duplicates return `200` with no effect; only allowlisted
  parsed fields persist.
- **Leakage:** the canary test captures logs, traces, metrics, Problem Details,
  and events and finds no canary phone number, OTP, proof, fingerprint, or
  envelope bytes. Redaction and secret-scan rules cover the new data classes.
- **Key separation:** Auth key purposes fail startup if any shares bytes with
  another Auth or Identity purpose.

## 5. Concurrency results

All results come from real PostgreSQL 17 / PostGIS 3.5 and are asserted exactly
in the integration suite.

| Scenario                                          | Required                                                           | Result |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| 50 bindings of one fingerprint × 10 rounds (R-08) | 1 `BOUND`, 49 `CONTACT_ALREADY_BOUND`, 1 active binding each round | PASS   |
| 50 starts for one number                          | exactly one `PENDING` challenge                                    | PASS   |
| 50 correct codes for one challenge (R-15)         | exactly one proof                                                  | PASS   |
| 50 wrong codes for one challenge (R-15)           | recorded failures ≤ attempt cap                                    | PASS   |
| 200 concurrent consumes of one bucket (R-17)      | admits exactly the limit                                           | PASS   |

## 6. Verification

Run on 2026-11-09 against `ada2b86` plus the fixes below, on local macOS arm64,
Node 22.14.0, pnpm 11.25.0, PostgreSQL 17.11 / PostGIS 3.5 (Docker), with
`TURBO_FORCE=true`:

```text
format:               PASS
lint:                 PASS
typecheck:            PASS (14/14 tasks, 0 cached)
architecture:         PASS (0 violations)
spec validate:        PASS (3 specs)
secret scan:          PASS (0 findings)
licenses:             PASS (276 packages, 0 findings)
unit:                 PASS (216/216, 32 files)
build:                PASS (8/8 tasks, 0 cached)
integration:          PASS (84/84, 17 files)
PostgreSQL/db verify: PASS (17/17 evidence flags)
dependency audit:     PASS (0 advisories at every severity)
```

The first run found one failure: `scripts/db/migrate.integration.test.ts`
compared the `db:verify` evidence to the 14 pre-T-91 flags and rejected the three
Auth flags that `ada2b86` added. The test now expects all 17 flags. `ada2b86` was
pushed straight to the integration branch, and the workflows run only on pull
requests and pushes to `main`, so hosted CI never ran it.

The first dependency audit reported one low advisory, `GHSA-389g-gv7q-r4x8`
(header-validation bypass in `fastify@5.12.5`, fixed in `5.12.6`).
`@nestjs/platform-fastify@12.0.4` pins `5.12.5` exactly, so a direct bump alone
would leave the running server on the vulnerable copy. A `pnpm-workspace.yaml`
override pins `fastify` to `5.12.6` across the workspace, leaving one copy in the
lockfile; remove it when Nest is upgraded to a release that requires `>= 5.12.6`.
The audit then reports 0 advisories.

Hosted CI on the stream PRs:

| PR  | Run           | Result                                                                               |
| --- | ------------- | ------------------------------------------------------------------------------------ |
| #8  | `41705687702` | integration FAIL (`max_connections` under parallel suites); fixed later by `b5baac6` |
| #9  | `41711533597` | all jobs PASS                                                                        |
| #10 | `41708782815` | all jobs PASS                                                                        |
| #11 | `41714773060` | all jobs PASS                                                                        |
| #12 | `41717093059` | all jobs PASS (this head contains every stream)                                      |

No hosted run covers the integration head after `ada2b86`. The integration pull
request to `main` (T-93) will be the first.

Machine-readable summary:
[`evidence/spec-001/verification-summary.json`](evidence/spec-001/verification-summary.json).

## 7. Requirements

| Req  | Status | Evidence                                                                                  |
| ---- | ------ | ----------------------------------------------------------------------------------------- |
| R-01 | PASS   | `architecture:check` (0 violations); `challenge-routes.integration.test.ts`               |
| R-02 | PASS   | `contact/phone-normalization.unit.test.ts`                                                |
| R-03 | PASS   | `contact/phone-normalization.unit.test.ts`                                                |
| R-04 | PASS   | `contact/contact-protection.unit.test.ts`                                                 |
| R-05 | PASS   | `contact/contact-protection.unit.test.ts`                                                 |
| R-06 | PASS   | `contact/contact-protection.unit.test.ts`                                                 |
| R-34 | PASS   | `contact/contact-protection.unit.test.ts`                                                 |
| R-07 | PASS   | `contact/contact-points.integration.test.ts`; `db-verify.json`                            |
| R-08 | PASS   | `contact/contact-points.integration.test.ts` (50 × 10, §5)                                |
| R-09 | PASS   | `contact/contact-points.integration.test.ts`                                              |
| R-10 | PASS   | `challenge/otp.unit.test.ts`                                                              |
| R-11 | PASS   | `challenge/otp.unit.test.ts`                                                              |
| R-12 | PASS   | `challenge/challenge-lifecycle.unit.test.ts`; `challenge/challenges.integration.test.ts`  |
| R-13 | PASS   | `challenge/challenges.integration.test.ts`                                                |
| R-14 | PASS   | `challenge/challenges.integration.test.ts`                                                |
| R-15 | PASS   | `challenge/challenges.integration.test.ts` (§5)                                           |
| R-16 | PASS   | `challenge/challenges.integration.test.ts`                                                |
| R-17 | PASS   | `rate-limit/subject-commitment.unit.test.ts`; `rate-limit/rate-limit.integration.test.ts` |
| R-18 | PASS   | `rate-limit/rate-limit-rules.unit.test.ts` (three defaults provisional, §8)               |
| R-19 | PASS   | `challenge/challenges.integration.test.ts`; `challenge-oracle.integration.test.ts`        |
| R-20 | PASS   | `rate-limit/rate-limit.integration.test.ts`                                               |
| R-21 | PASS   | `challenge/challenges.integration.test.ts`; `challenge-oracle.integration.test.ts`        |
| R-22 | PASS   | `challenge-oracle.integration.test.ts` (local timing only, §8)                            |
| R-23 | PASS   | `delivery/synthetic-delivery.unit.test.ts`; `challenge-leak.integration.test.ts`          |
| R-24 | PASS   | `challenge/challenges.integration.test.ts`; `delivery/synthetic-delivery.unit.test.ts`    |
| R-25 | PASS   | `callbacks/callback-ingress.integration.test.ts`                                          |
| R-26 | PASS   | `callbacks/callback-ingress.integration.test.ts`; `challenge-routes.integration.test.ts`  |
| R-27 | PASS   | `callbacks/callback-ingress.integration.test.ts`                                          |
| R-28 | PASS   | `callbacks/callback-ingress.integration.test.ts`                                          |
| R-29 | PASS   | `contact/contact-points.integration.test.ts`; `challenge/challenges.integration.test.ts`  |
| R-30 | PASS   | `contact/contact-points.integration.test.ts`; `shared/outbox-writer.unit.test.ts`         |
| R-31 | PASS   | `challenge-leak.integration.test.ts` (span check is a static source scan, §8)             |
| R-32 | PASS   | `challenge-routes.integration.test.ts` (code list amended, §8)                            |
| R-33 | PASS   | `db-verify.json`; refuse-down tests in each stream's integration suite                    |

Module test paths are relative to `modules/auth/test/`; route, oracle, and leak
tests are in `apps/api/test/auth/`.

Summary: 34 PASS, 0 FAIL.

## 8. Deviations, provisional values, and open items

**`INVALID_REQUEST` (R-32), resolved by amendment.** The challenge routes answer
schema violations (unknown fields, wrong types, a missing or malformed
installation header) with `400 INVALID_REQUEST`. That is Foundation's code for
every `400` (`apps/api/src/http/problem-details.ts`), but design §2.3 and PLAN §15
did not list it. On 2026-11-09 the owner chose to amend both lists rather than
change the routes. The code depends only on the request's shape, never on
account or contact state, so it reveals nothing that P2-AC-035 protects.

**Provisional rate-limit defaults.** PLAN §11 does not set these, so the
implementation uses placeholders pending Trust & Safety:
`PASSWORD_FAILURE_NETWORK_HOUR=50`, `REVERIFICATION_GLOBAL_HOUR=100`,
`DELIVERY_GLOBAL_MINUTE=60`.

**Timing bound (R-22).** The 20 ms median bound was measured locally and on
hosted CI runners, not under production load or network conditions.

**Span check (R-31).** No tracing exporter exists yet, so the span part of the
canary check is a static scan of Auth sources for attributes that could carry
restricted values. A runtime span capture should replace it when tracing lands.

**Spec corrections made during implementation.** Outbox `aggregateType` is
`auth_contact`/`auth_challenge` (Phase 0 forbids `.`). ws-d depends on ws-b,
because the delivery-status function updates `auth.verification_challenges`;
`streams.json` now says so. `HTTP_TRUSTED_PROXY_HOPS` did not exist and was added
by the integration amendment.

**`fastify` override.** The `fastify: 5.12.6` override in `pnpm-workspace.yaml`
(§6) is temporary until `@nestjs/platform-fastify` is upgraded.

**Local demo limitation.** The synthetic delivery adapter keeps the code in
server memory only, so a person cannot complete `verify` against a local API
without a development-only code viewer, which does not exist.

## 9. Phase 2 acceptance criteria touched by SPEC-001

SPEC-001 provides evidence toward, but does not close, these criteria:
P2-AC-001, 002, 004–014, 031–035. P2-AC-003 (ADR-013 accepted), P2-AC-036
(threat register), P2-AC-040 (hosted `verify:full` on the final head), and
P2-AC-041 (independent audit) remain open for the whole phase. P2-AC-037–039 are
production-only.

## 10. Next state

```text
SPEC-001 — IMPLEMENTED ON INTEGRATION BRANCH (T-00..T-92 done)
SPEC-001 T-93 — BLOCKED: merge to main requires Phase 1 PASS and ADR-013 accepted
SPEC-002, SPEC-003 — NOT STARTED
PHASE 2 — NOT CLOSED
```
