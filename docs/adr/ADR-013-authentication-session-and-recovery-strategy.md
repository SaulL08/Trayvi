# ADR-013 — Authentication, Session, and Recovery Strategy

**Status:** Proposed  
**Date:** 2026-11-02  
**Owners:** Auth, Security, Identity, and Trayvi architecture

## Context

Phase 1 created one base account per person but no way to prove control of it. Phase 2 must let a
person sign in, keep revocable sessions, and recover access without ever creating a second account.
The first market is the Dominican Republic, where users mostly reach services through a mobile phone
number, connections can be slow and unreliable, and SIM swap is a known takeover path.

The [Phase 2 plan](../phases/phase-02-authentication-sessions-recovery/PLAN.md) and specs SPEC-001 to
SPEC-003 rely on decisions that must hold across modules and phases: the primary factor, how
contacts and one-time codes are protected, the token model, password hashing, assurance and step-up,
recovery, provider callbacks, and where the cryptography lives. This ADR records them.

Phase 1 is not closed (audit `FAIL`, remediation pending retest). This ADR can be reviewed now, but
it cannot be accepted, and no Phase 2 stream can start, until Phase 1 records `PASS`.

## Decision drivers

- Resistance to account takeover, including SIM swap and refresh-token theft.
- No enumeration: no response may reveal whether a phone number or document is registered to a caller
  who has not proven possession.
- Immediate, reliable revocation.
- Database-enforced single use and uniqueness under concurrency.
- Low operational burden for a modular monolith with no key-signing service.
- Tolerance of retries on poor mobile networks.
- Reuse of the reviewed Phase 1 cryptographic constructions, with separate key purposes.
- No new native dependency without review.

## Considered options

### Primary factor

- Password only: rejected. Phones are the main identifier in the market, passwords are reused, and
  password-only recovery would still need a contact factor.
- Email OTP or magic link: rejected for the first market, where email is less used than the phone.
- Passkeys/WebAuthn as primary: deferred. Device support is uneven in the target market and the
  mobile apps do not exist yet (Phases 14–15). The credential model leaves room for it.
- **Phone OTP as primary, optional password as second factor: selected.**

### Token model

- Signed JWT access tokens with refresh tokens: rejected for now. Revocation would need a deny list
  or wait for expiry, and signing keys need their own rotation and custody.
- **Opaque access tokens resolved in PostgreSQL on every request, plus rotating opaque refresh
  tokens: selected.**

### Refresh reuse handling

- Strict single use with family revocation on any reuse: rejected. A lost response on a flaky
  network would sign the user out and teach users to ignore reuse alerts.
- **Single use with a narrow grace rule: selected.** See the decision below.

### Password hashing

- bcrypt: rejected. It truncates input at 72 bytes and is not memory-hard.
- Argon2id through a native package: deferred. Node 22 has no built-in Argon2, and a native
  dependency needs supply-chain review.
- **`scrypt` from Node's crypto module, versioned: selected.**

### Where contact cryptography lives

- Extract a shared `packages/crypto` used by Identity and Auth now: rejected for now. Phase 1 said not
  to extract until a second owner shows the right abstraction, and Auth needs different AAD and
  envelope owners.
- **Private Auth adapter using the same reviewed constructions with separate keys: selected.**

## Decision

### Contact points

The primary factor is possession of a phone number, verified by OTP. Phone input is normalized
under the immutable profile `e164-v1` (PLAN §6). Allowed calling codes, national number lengths, and
national destination codes are configuration, so no market is hardcoded. The first configuration
allows calling code `1` with national length `10` and destination codes `809`, `829`, `849`.

Contact equality uses HMAC-SHA-256 over NUL-joined fields `trayvi.auth-contact-fingerprint`,
profile, channel, and canonical value. The stored number, kept only for security notices and
recovery messages, uses the Phase 1 AES-256-GCM envelope construction with AAD bound to the contact
or pending-case owner. PostgreSQL enforces at most one `ACTIVE` contact per fingerprint scope and one
`ACTIVE` primary contact per account. Contact HMAC rotation follows the ADR-012 dual-alias protocol.

### Key purposes

Auth uses four keys: `auth-contact-fingerprint`, `auth-contact-kek`, `auth-otp-commitment`, and
`auth-subject-commitment`. They are separate from each other and from every Identity key. Startup
fails when any two configured purposes share key bytes, closing the gap found in `P1-AUD-004`.
Provider callback secrets are separate per provider.

### One-time codes

Codes are 6 ASCII digits, drawn uniformly from a CSPRNG with rejection sampling. Only a keyed
commitment is stored: HMAC-SHA-256 over `trayvi.auth-otp-commitment`, `otp-v1`, challenge ID,
purpose, and code. Verification compares in constant time. Each challenge has one purpose and is
bound to the installation that started it. Defaults (5-minute lifetime, 5 attempts, 3 resends,
30-second cooldown, 10-minute proof lifetime) are configuration within validated bounds.

Starting a sign-in or registration challenge never reads account state. Only after a correct code
does the response tell the proven holder whether an account exists for the number.

### Rate limiting

Abuse limits are PostgreSQL buckets keyed by an HMAC commitment of the subject under
`auth-subject-commitment`, incremented with one atomic upsert. Rows hold no plain phone number or
network address. Contact-dimension limits answer with the same generic response as an accepted start
and send nothing; network and installation limits answer `RATE_LIMITED`. Limits per challenge and
per number per day bound an attacker's chance of guessing one number's code to at most `10 / 10^6`
per day.

### Tokens and sessions

Access (`tva_`), refresh (`tvr_`), contact-proof (`tvp_`), and recovery-case (`tvc_`) tokens are
32 CSPRNG bytes in base64url behind a prefix that secret scanners detect. PostgreSQL stores only the
SHA-256 hash. These values carry 256 bits of entropy, so an unkeyed hash gives no offline guessing
advantage, unlike phone numbers or documents. Tokens travel only in the `Authorization` header or a
JSON body, never in URLs.

Access tokens live 10 minutes and are resolved in PostgreSQL on every request, together with family
state and account status. There is no cache, so sign-out, revocation, and suspension take effect on
the next request. A session family lasts at most 90 days and expires after 30 idle days.

Rotation runs in a guarded `SECURITY DEFINER` function that locks the family row; the runtime role
cannot change token or family state directly. A partial unique index allows one `ISSUED` refresh
token per family. A `ROTATED` token is accepted as a retry only if it was rotated at most 30 seconds
ago, is the immediate predecessor of the current token, that successor has never been used, and the
request comes from the same installation. The retry replaces the unused successor. Any other reuse
revokes the whole family.

`AccountSessionRevoker` revokes every family of an account inside the caller's transaction. Phase 3
suspension and closure commands must call it.

### Passwords, assurance, and step-up

A password is optional. When one is active, sign-in requires the contact proof and the password, and
the session is `AAL2`; otherwise it is `AAL1`. The contact proof is consumed even when the password
is wrong, so every password guess costs a new OTP.

Passwords are hashed with `scrypt`, `N = 2^17`, `r = 8`, `p = 1`, a 16-byte salt, and a 32-byte
output, under parameter version `scrypt-v1`. A successful verification under older parameters
rehashes. Policy is 12–128 characters after NFC normalization, no composition rules, and rejection
of known-compromised passwords through a port. Changing a password revokes every other family.

Routes declare a step-up requirement (maximum age of the last factor and minimum assurance). The
guard answers `STEP_UP_REQUIRED` when it is not met. The guard resolves a principal with account,
session, assurance, authentication time, account status, and restrictions. It makes no permission
decision; that is Phase 3.

### Recovery

Recovery restores control of the existing account. It never creates an account, identity, or second
contact binding.

| Tier | Situation                            | Required proofs                                                                                    | Cooling-off |
| ---- | ------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------- |
| 0    | New device, same number              | Normal sign-in; not a recovery case                                                                | none        |
| 1    | Forgot password, still has number    | OTP to the current number; identity re-verification if the identity is established                 | 24 hours    |
| 2    | Lost the number                      | OTP to the new number; identity re-verification matching the established identity; password if set | 72 hours    |
| 3    | Phase 1 duplicate-document candidate | Same as Tier 2, entered through the opaque candidate reference                                     | 72 hours    |

During cooling-off the current number, if any, receives a notice, and the owner can cancel through an
active session or an OTP to that number. Completion replaces the contact or removes the password,
revokes every family, and applies time-bounded restrictions in one transaction. `HIGH_RISK_ACTIONS`
is the restriction later phases (payouts, balance withdrawal) must honor. No restriction ever blocks
recovery, so the owner can always take the account back; re-verification stops an attacker from
bouncing it back.

Recovery starts for unknown numbers or references create decoy cases that follow the same steps and
can never match at re-verification. This keeps recovery from becoming an existence oracle. A new
start supersedes an open case that is still collecting proofs; a case in cooling-off can only be
cancelled by the owner.

An authenticated contact change follows the same pattern: recent `AAL2`, or `AAL1` plus
re-verification, an OTP to the new number, 24-hour cooling-off with notice, and restrictions.

### Identity re-verification

Identity owns re-verification because only Identity can compare a presenter with the bound document
claims. It exposes a narrow port that opens a request for an account (or none, for a decoy) and
resolves it to `MATCHED` or `NOT_MATCHED`. The presenter's document is normalized and fingerprinted
in memory and compared with the bound claims; neither the value nor the provider payload is stored.
Re-verification never changes Phase 1 identity state. Auth never sees identity IDs, and the two
modules do not import each other; the API composition root wires them.

### Provider callbacks

Inbound provider callbacks are verified before parsing: a body of at most 16 KiB, an HMAC-SHA-256
signature over the timestamp and raw body under a per-provider secret, and a timestamp within 5
minutes. Unknown provider, bad signature, and stale timestamp all receive one identical `401`. A
receipt unique on provider alias, callback kind, and provider event ID makes processing idempotent.
Only allowlisted parsed fields reach handlers, and raw payloads are not retained.

### Placement

Auth is a new business module, `modules/auth`, with domain, application, and infrastructure layers.
PostgreSQL adapters receive a `SqlExecutor` from the caller, so registration and recovery can share
one transaction with Accounts and Identity writes. Contact cryptography stays private to Auth.

## Consequences

- Every authenticated request costs one indexed PostgreSQL lookup. This is accepted for the pilot; a
  cache is reconsidered only with measured load and must keep revocation within a defined bound.
- Onboarding sends a second OTP after identity submission, because issuing tokens only when an
  account is created would expose duplicate documents. Sign-in afterwards still reveals whether the
  account was created, so a holder of one phone can learn whether a document number is registered.
  Per-contact and per-network registration limits bound this. It stays a High production blocker
  until Trust & Safety accepts it or a design removes it.
- Accounts without a password remain exposed to SIM swap at sign-in. Cooling-off, notices, and
  restrictions limit the damage only for recovery and contact change. Drivers should be required to
  set a password before going online (Phase 5 decision).
- Decoy cases may cost real provider calls once a re-verification provider exists.
- The worker gains a database pool and scheduled jobs to complete and expire cases.

## Security/privacy/operational impact

A database dump yields token hashes, scrypt hashes, keyed fingerprints, and envelopes, none usable
without the external keys or a brute force against 256-bit values. Phone numbers, codes, passwords,
and tokens are excluded from logs, traces, metrics, errors, events, URLs, and analytics, and the
token prefixes let the secret scanner find leaks.

Production remains blocked on: selecting SMS/WhatsApp and re-verification providers, custody and
rotation of Auth keys and callback secrets, approved retention for contacts, sessions, and recovery
cases, telecom consent rules, and Trust & Safety approval of limits, durations, and the
document-registration risk. Synthetic adapters only until then.

## Validation and revisit triggers

Validate the PLAN §§6–9 vectors, every normalization case, key-purpose collision rejection, OTP
uniformity, challenge and recovery transition matrices, 50-way contact-binding and verification
races, the 100-way refresh race over 10 rounds, grace-rule edges, revocation on the next request,
enumeration parity for challenge, registration, and recovery responses, callback forgery and replay,
injected-failure atomicity, runtime-role grants, and canary leak scans.

Revisit when:

- the runtime offers Argon2id or a reviewed package is approved (supersede `scrypt-v1`);
- measured lookup load justifies an access-token cache or signed tokens;
- the mobile apps can support passkeys;
- a second market needs channels other than phone;
- a real provider changes the re-verification evidence shape;
- Trust & Safety rejects the document-registration risk;
- a third owner of the same cryptographic constructions appears (reconsider a shared package).

## References

- [Phase 2 Plan](../phases/phase-02-authentication-sessions-recovery/PLAN.md)
- [SPEC-001](../phases/phase-02-authentication-sessions-recovery/specs/SPEC-001-contact-verification-challenges/design.md),
  [SPEC-002](../phases/phase-02-authentication-sessions-recovery/specs/SPEC-002-sign-in-and-sessions/design.md),
  [SPEC-003](../phases/phase-02-authentication-sessions-recovery/specs/SPEC-003-account-recovery/design.md)
- [ADR-007](ADR-007-api-errors-and-idempotency.md), [ADR-008](ADR-008-transactional-outbox.md),
  [ADR-009](ADR-009-observability-redaction-and-audit.md),
  [ADR-011](ADR-011-account-person-identity-model.md),
  [ADR-012](ADR-012-national-identity-protection-and-key-rotation.md),
  [ADR-019](ADR-019-phase-0-audit-remediation-invariants.md),
  [ADR-020](ADR-020-spec-driven-development-and-parallel-streams.md)
