# SPEC-002 — Sign-in, credentials, and sessions — Requirements

Status: Approved (early, see §7)  
Phase: `phase-02-authentication-sessions-recovery` ([PLAN.md](../../PLAN.md))  
Owners: Auth  
Last updated: 2026-11-09

## 1. Purpose

This spec turns a contact proof from SPEC-001 into a revocable session. It adds
the optional password credential, opaque access tokens, rotating refresh tokens
with family reuse detection, sign-out and revocation, the authentication guard
and principal, step-up checks, and the binding of a verified contact to Phase 1
account registration. It refines PLAN §§5.4, 9, 10, 12, and 15. It builds on SPEC-001's integration branch
(see §7), not on `main`.

## 2. Scope

### 2.1 In scope

- Session families, sessions, refresh tokens, rotation, grace retries, reuse
  detection, expiry, and revocation, including `AccountSessionRevoker`.
- Password credentials: hashing, policy, compromised-password check, failure
  limits, rehash on parameter upgrade.
- The authentication guard, principal, public-route allowlist, and step-up.
- `AccountStateReader` over Phase 1 accounts.
- Registration routes that require a contact proof and bind the contact inside
  the Phase 1 enrollment transaction.
- Session, sign-in, password, and own-account routes.

### 2.2 Out of scope

- Recovery, contact change, and restriction storage: SPEC-003. This spec reads
  restrictions through `RestrictionReader`, whose implementation here always
  returns an empty list.
- Permissions and staff revocation routes: Phase 3. Phase 3 calls
  `AccountSessionRevoker`.
- Browser cookies and CSRF: Phase 11.

## 3. Requirements

| Id   | Requirement                                                                                                                                                                                                          | Traces to            | Verified by             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- |
| R-01 | The token codec shall issue `tva_` and `tvr_` tokens from 32 CSPRNG bytes, store only their SHA-256 hashes, and reproduce the PLAN §9.1 vector.                                                                      | P2-AC-017            | ws-a                    |
| R-02 | When a session is issued, the system shall create one `ACTIVE` family, one session, and one `ISSUED` refresh token in one transaction, with factors, assurance, authenticated-at, idle and absolute expiry.          | P2-AC-015, P2-AC-031 | ws-a                    |
| R-03 | When an access token is resolved after its expiry, after its family is revoked or expired, or when unknown or malformed, the resolver shall return `INVALID` without distinguishing the cause.                       | P2-AC-018, P2-AC-021 | ws-a                    |
| R-04 | When an `ISSUED` refresh token is presented within idle and absolute limits, the system shall mark it `ROTATED`, issue one successor and one session, and extend idle expiry, never absolute expiry.                 | P2-AC-018, P2-AC-019 | ws-a                    |
| R-05 | When a `ROTATED` token is presented and every PLAN §9.3 grace condition holds, the system shall revoke the unused successor and issue a fresh one without revoking the family.                                       | P2-AC-019            | ws-a                    |
| R-06 | If a `ROTATED` token is presented outside the grace conditions, or any token of a revoked family is presented, then the system shall revoke the family with `REUSE_DETECTED` and emit `auth.session.reuse-detected`. | P2-AC-019            | ws-a                    |
| R-07 | PostgreSQL shall reject a second `ISSUED` refresh token in one family and any transition out of a terminal family state.                                                                                             | P2-AC-019, P2-AC-034 | ws-a                    |
| R-08 | When 100 connections refresh the same token concurrently, each of 10 rounds shall end with at most one `ISSUED` token and a family that is either `ACTIVE` with a consistent chain or `REVOKED`.                     | P2-AC-020            | ws-a                    |
| R-09 | When a principal signs out, revokes one family, revokes other families, or `AccountSessionRevoker` revokes all families, the next request with an affected token shall fail.                                         | P2-AC-021, P2-AC-022 | ws-a, ws-e              |
| R-10 | `AccountSessionRevoker.revokeAllForAccount` shall run in the caller's transaction so revocation commits or rolls back with the caller's change.                                                                      | P2-AC-022, P2-AC-031 | ws-a                    |
| R-11 | Passwords shall be hashed with `scrypt-v1` parameters from PLAN §10 and a 16-byte random salt; a successful verification under older parameters shall rehash.                                                        | P2-AC-016            | ws-b                    |
| R-12 | When a password is set, the system shall apply NFC normalization, enforce 12–128 characters, and reject passwords the `CompromisedPasswordChecker` reports.                                                          | P2-AC-016            | ws-b                    |
| R-13 | If password failures exceed the `PASSWORD_FAILURE_ACCOUNT` or `PASSWORD_FAILURE_NETWORK_HOUR` limits, then verification shall return `RATE_LIMITED` without evaluating the password.                                 | P2-AC-016, P2-AC-011 | ws-b                    |
| R-14 | PostgreSQL shall allow at most one `ACTIVE` password credential per account.                                                                                                                                         | P2-AC-016, P2-AC-034 | ws-b                    |
| R-15 | When a password is set or changed, the system shall revoke every other family with `PASSWORD_CHANGED`, emit `auth.password.changed`, and request an old-contact security notice.                                     | P2-AC-016, P2-AC-021 | ws-b, ws-e              |
| R-16 | `AccountStateReader` shall return the current Phase 1 account status and version through an application port, with no import of Accounts infrastructure.                                                             | P2-AC-002, P2-AC-022 | ws-c                    |
| R-17 | When registration starts, the system shall consume a `CONTACT_PROOF` and record a contact reservation for the enrollment operation in the same transaction.                                                          | P2-AC-025            | ws-c                    |
| R-18 | When identity submission creates the account, the same transaction shall re-check the re-entered phone against the reservation and bind it as the primary contact.                                                   | P2-AC-025, P2-AC-031 | ws-c                    |
| R-19 | If the contact is already bound or the document is already claimed, then registration shall roll back fully and return Phase 1's generic accepted envelope, identical in status, schema, and size class.             | P2-AC-025, P2-AC-012 | ws-c                    |
| R-20 | Registration starts shall be limited by `REGISTRATION_START_CONTACT_30D` and `REGISTRATION_START_NETWORK_DAY`.                                                                                                       | P2-AC-025, P2-AC-011 | ws-c                    |
| R-21 | Every route not on the public allowlist (PLAN §9.4) shall require a valid access token and shall reject requests for `SUSPENDED` or `CLOSED` accounts with `AUTHENTICATION_REQUIRED`.                                | P2-AC-022, P2-AC-023 | ws-d                    |
| R-22 | The guard shall attach a principal with account, session, family, authenticated-at, assurance, factors, account status and version, and restrictions, and shall make no permission decision.                         | P2-AC-023            | ws-d                    |
| R-23 | When a route declares a step-up requirement that the principal does not meet, the guard shall return `STEP_UP_REQUIRED` with the required assurance and maximum age.                                                 | P2-AC-024            | ws-d                    |
| R-24 | When a principal completes a `STEP_UP` challenge, the family's authenticated-at and factors shall update without issuing a new family.                                                                               | P2-AC-024            | ws-a, ws-e              |
| R-25 | A route inventory test shall list every registered route and fail when a route is neither guarded nor on the allowlist.                                                                                              | P2-AC-023            | ws-d                    |
| R-26 | When sign-in receives a contact proof, the system shall consume it once, find the bound account, require the password when one is active, and issue a session with `AAL1` or `AAL2`.                                 | P2-AC-015            | ws-e                    |
| R-27 | If the proof is rejected, no account is bound, the account is `SUSPENDED` or `CLOSED`, or the password does not match, then sign-in shall return `AUTHENTICATION_FAILED` and the proof shall stay consumed.          | P2-AC-015, P2-AC-035 | ws-e                    |
| R-28 | When sign-in creates a family for an installation not seen on the account before, the system shall request a `SECURITY_NOTICE_NEW_SESSION` delivery after commit.                                                    | P2-AC-015            | ws-e                    |
| R-29 | `GET /api/v1/accounts/me` shall return only the principal's own account status, assurance, and restrictions.                                                                                                         | P2-AC-023            | ws-e                    |
| R-30 | Events from this spec shall carry only the fields in design §2.3.                                                                                                                                                    | P2-AC-032            | ws-a, ws-b              |
| R-31 | Canary passwords, access tokens, refresh tokens, and contact proofs shall be absent from logs, traces, metrics, Problem Details, events, and URLs.                                                                   | P2-AC-017, P2-AC-033 | ws-e                    |
| R-32 | Migrations `0017`–`0019` shall pass `up -> verify -> down -> up -> verify` and grant the runtime role only the privileges in design §2.2.                                                                            | P2-AC-034            | ws-a..ws-c, integration |

## 4. Security, privacy, and abuse requirements

This spec closes these PLAN §18 threats: refresh token theft (R-04–R-07),
access token theft (R-03, R-09), concurrent refresh race (R-08), session fixation
(R-02), revocation lag (R-03, R-09, R-21), password guessing and stuffing
(R-12, R-13, R-27), SIM swap (partially, through `AAL2`, R-26), and log leakage
(R-31). It bounds, but does not close, the document-registration oracle (R-19,
R-20).

Data classes touched: token hashes, password hash and salt, installation
commitment, network-prefix commitment, contact reservation fingerprint (PLAN §17).

## 5. Non-functional requirements

- Every authenticated request costs one indexed PostgreSQL lookup joining
  session, family, and account status. Target p95 under 5 ms on the integration
  database; no cache.
- Rotation locks one family row; no lock spans more than one family.
- `scrypt-v1` verification must not block the event loop: it runs through the
  asynchronous Node API, and concurrent password verifications are capped by a
  configured semaphore (default 8).
- Clock-dependent behavior uses the injected `Clock`.

## 6. Open questions

| Question                                                                                                                                                                                | Owner          | Blocks approval |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------- |
| ~~Confirm migration numbers after SPEC-001 integrates.~~ Resolved: `0017`–`0019` (SPEC-001 holds `0012`–`0016`).                                                                        | Auth           | Resolved        |
| ~~`scrypt-v1` or Argon2id (ADR-013).~~ Resolved: `scrypt-v1`, as ADR-013 proposes.                                                                                                      | Architecture   | Resolved        |
| ~~Accept the document-registration oracle with the R-20 limits, or redesign.~~ Resolved: accepted with the R-20 limits as a residual risk; Trust & Safety reviews it before production. | Trust & Safety | Resolved        |
| Skip the second OTP after identity submission.                                                                                                                                          | Product        | No              |
| Session lifetime defaults for drivers versus customers.                                                                                                                                 | Product        | No (config)     |

## 7. Approval record

- 2026-11-09: approved by the repository owner, who asked to start the
  implementation and chose `scrypt-v1` and acceptance of the
  document-registration oracle with the R-20 limits.
- Like SPEC-001, this approval is **ahead of the PLAN §1 gate**: Phase 1 has not
  recorded a final `PASS` and ADR-013 is still `Proposed`. SPEC-001 is not
  `integrated` either, so this spec's integration branch starts from
  `spec/001-contact-verification-challenges/integration` and depends on its
  contracts as built. It shall not merge to `main` before SPEC-001 does.
- The oracle acceptance is a residual risk: a person who controls many phone
  numbers can still learn, within the R-20 limits, whether a document is already
  registered. It is recorded for Trust & Safety review before production.
- Correction from SPEC-001: the outbox aggregate types are `auth_session` and
  `auth_credential`, because Phase 0's `outbox_aggregate_type_format` check
  forbids `.`.
