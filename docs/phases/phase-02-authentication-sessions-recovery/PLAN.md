# Phase 2 — Authentication, Sessions, Verification and Recovery — Plan

Status: DRAFT — REVIEW REQUIRED; NOT READY FOR IMPLEMENTATION  
Planned phase: 2  
Scope owners: Auth  
Last updated: 2026-11-09

## 1. Decision and scope

This document is the implementation contract for Phase 2. It plans the smallest
coherent authentication foundation that lets the one base account from Phase 1
prove control of a contact point, sign in, hold revocable rotating sessions, and
recover access without ever creating a second account.

The planning decision is:

```text
PHASE 2 — AUTHENTICATION, SESSIONS, VERIFICATION AND RECOVERY — PLAN
DRAFT — REVIEW REQUIRED
NOT READY FOR IMPLEMENTATION: PHASE 1 IS NOT CLOSED
```

Phase 1 is not closed. Its adversarial audit
([AUDIT.md](../phase-01-accounts-identity/AUDIT.md)) records `FAIL` with two High
and three Medium findings. Remediation exists on `fix/phase-01-remediation`
(migrations `0008`–`0010`) and has not been retested to `PASS`. Under the
roadmap rule, this plan is exploratory: it may be reviewed and its specs written,
but no Phase 2 stream may start, and no spec may become `approved`, until Phase 1
records a final `PASS`.

### 1.1 In scope for a later, separately authorized implementation

- A new `modules/auth` business module with domain/application/infrastructure
  layering.
- Phone contact points: normalization, keyed fingerprint, envelope encryption,
  database-enforced uniqueness, and binding to the one base account.
- One-time-passcode (OTP) verification challenges behind a provider-neutral
  delivery port, with expiry, attempt limits, resend limits, and single use.
- PostgreSQL-backed, enumeration-safe rate limiting for every unauthenticated
  and credential-guessing surface.
- Authenticated, replay-protected, idempotent provider callbacks.
- Sign-in from a verified contact proof, plus an optional password credential
  that raises assurance and defends against SIM swap.
- Opaque access tokens, rotating single-use refresh tokens, session families,
  reuse detection, logout, and self-service revocation.
- An authentication guard that resolves a principal for every non-public API
  route and enforces account state, recent authentication, and assurance level.
- Registration binding: Phase 1 account creation requires a verified contact
  proof, and the contact binds to the new account atomically.
- Risk-tiered account recovery, identity re-verification through a narrow
  Identity seam, cooling-off, old-contact notice, and post-recovery
  restrictions.
- Authenticated contact change under the same controls as recovery.
- ADR-013 as the required decision record.

### 1.2 Explicitly out of scope

- Roles, permissions, grants, support impersonation, staff consoles, and the
  complete append-only audit control plane. These belong to Phase 3.
- Account suspension, restriction, or closure commands by staff. Phase 2 only
  enforces the state these commands produce and supplies the session-revocation
  port they must call.
- Device reputation, risk scoring, and fraud rules beyond the explicit rate limits
  and recovery tiers here. Phase 3 adds device/risk signals; Phase 13 adds the
  fraud engine.
- Selecting or contracting a real SMS, WhatsApp, or identity-verification
  provider. Phase 2 ships synthetic adapters only.
- Passkeys/WebAuthn, email, social login, and federated identity. The credential
  model leaves room for them; none is implemented.
- Browser cookie sessions and CSRF defenses. The first browser surface is the
  admin web (Phase 11), which must plan them.
- Push and in-app notification delivery (Phase 9). Phase 2 sends only security
  messages through the OTP delivery port.
- Customer or driver applications (Phases 14–15).
- Any change to the Phase 1 cryptographic byte contracts, uniqueness invariants,
  or lifecycles.

## 2. Source constraints carried forward

- Trayvi remains a modular monolith; `apps/api` and `apps/worker` compose
  modules and contain no domain rules.
- PostgreSQL is authoritative for uniqueness, single use, and state invariants.
  Application checks improve diagnostics but are never the concurrency control.
- Exposed identifiers are opaque UUIDv7 values (ADR-004).
- Schema changes are ordered, immutable SQL migrations; runtime roles have no
  DDL privilege (ADR-003, ADR-019).
- APIs use `/api/v1`, Problem Details, rejection of unknown fields, and
  principal-and-operation-scoped idempotency (ADR-007).
- State changes and safe events commit together through the transactional outbox
  (ADR-008).
- Configuration is read only through `packages/config` and fails closed
  (ADR-006).
- Phone numbers, OTPs, passwords, tokens, and their protected derivatives never
  enter logs, traces, metrics, URLs, event payloads, or analytics (ADR-009).
- Phase 1 invariants hold: one person identity per account, no second account on
  duplicate input, generic duplicate outcomes, and no silent reopening of a
  `CLOSED` account.

## 3. Ubiquitous language and ownership

| Concept                   | Definition                                                                                                     | Owning module | Must not own                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| Contact point             | A phone number bound to an account after proven possession.                                                    | Auth          | Identity documents, profile data            |
| Verification challenge    | A single-purpose OTP sent to a destination, with expiry and attempt budget.                                    | Auth          | Account state                               |
| Contact proof             | A short-lived, single-use artifact proving a caller verified a destination for one purpose.                    | Auth          | Session rights                              |
| Password credential       | An optional knowledge factor bound to an account.                                                              | Auth          | Recovery decisions                          |
| Session family            | The chain of refresh tokens descended from one sign-in on one installation.                                    | Auth          | Permissions                                 |
| Session                   | One access-token lifetime inside a family.                                                                     | Auth          | Business authorization                      |
| Principal                 | The authenticated subject resolved for a request: account, session, assurance, auth time, state, restrictions. | Auth          | Role or permission decisions (Phase 3)      |
| Assurance level           | `AAL1` for one factor, `AAL2` for two independent factors.                                                     | Auth          | Identity assurance (Identity owns that)     |
| Recovery case             | A governed attempt to restore control of an existing account.                                                  | Auth          | A new account or identity                   |
| Re-verification           | A trusted check that a presenter matches an already established identity.                                      | Identity      | Session or contact changes                  |
| Post-recovery restriction | A time-bounded block on high-risk actions after recovery or contact change.                                    | Auth          | Enforcement in later modules (they read it) |
| Provider callback receipt | The record that a signed provider event was accepted once.                                                     | Auth          | Raw provider payloads                       |
| Rate-limit bucket         | A keyed counter for one abuse dimension and window.                                                            | Auth          | Plain IP addresses or phone numbers         |

### 3.1 Cardinality invariants

1. An account has at most one `ACTIVE` primary phone contact point.
2. A phone number, within its normalization profile and fingerprint key version,
   has at most one `ACTIVE` contact point across all accounts.
3. A contact proof is consumed at most once.
4. A session family has at most one refresh token in state `ISSUED`.
5. An account has at most one open recovery case.
6. Recovery and contact change target the existing account; they never create an
   account, identity, or second contact binding.

## 4. Module and layer boundaries

```text
modules/
  auth/
    src/
      contracts/        frozen cross-stream types and ports (integration-owned)
      domain/           pure rules per capability subdirectory
      application/      use cases and ports per capability subdirectory
      infrastructure/   crypto, PostgreSQL, and synthetic provider adapters
```

The dependency direction is `domain <- application <- infrastructure`. Auth does
not import Accounts or Identity infrastructure. Collaboration goes through
application ports that `apps/api` and `apps/worker` wire:

- `AccountStateReader` (Accounts) — current status and version for an account.
- `AccountEnrollmentGateway` (Accounts) — Phase 1 enrollment, extended to accept a
  verified contact binding.
- `IdentityReverificationPort` (Identity) — open and resolve a re-verification
  case for an established identity.
- `AccountSessionRevoker` (Auth) — revoke every family for an account; Phase 3
  suspension and closure commands must call it in their transaction.

PostgreSQL adapters in `modules/auth/src/infrastructure/` receive a narrow
`SqlExecutor` from the composition root, so one transaction can span modules when
a use case requires it (registration binding, recovery completion). Auth adds no
database driver dependency.

Cryptographic orchestration for contact points is private to Auth. It uses the
same reviewed primitives as Identity (HMAC-SHA-256, AES-256-GCM) with separate
keys. Extraction into a shared package is an open engineering decision (§19.1);
until ADR-013 decides it, no shared crypto package is created.

## 5. Domain model and lifecycles

### 5.1 Aggregate records

| Record                       | Essential fields                                                                                                                                                           | Invariants                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `contact_points`             | UUIDv7 ID, account ID, channel, role, normalization profile, fingerprint key version, 32-byte fingerprint, envelope, state, times                                          | Partial unique index on active fingerprint scope; one active primary per account |
| `contact_point_transitions`  | UUIDv7 ID, contact ID, from/to, actor class, reason code, recovery/change case ref, time                                                                                   | Append-only                                                                      |
| `verification_challenges`    | UUIDv7 ID, purpose, destination fingerprint and key version, OTP commitment, installation commitment, counters, times, state                                               | No plaintext OTP or destination; counters bounded by `CHECK`                     |
| `contact_proofs`             | UUIDv7 ID, challenge ID, purpose, destination fingerprint, proof-token hash, installation commitment, expiry, consumed time                                                | Consumed at most once; expiry ≤ 10 minutes after verification                    |
| `password_credentials`       | UUIDv7 ID, account ID, algorithm, parameter version, salt, hash, state, times                                                                                              | At most one `ACTIVE` per account                                                 |
| `session_families`           | UUIDv7 ID, account ID, installation commitment, factors, assurance, authenticated-at, idle/absolute expiry, state, revoke reason                                           | Revoked families never reactivate                                                |
| `sessions`                   | UUIDv7 ID, family ID, access-token hash, issued/expires times, state                                                                                                       | Access token hash unique                                                         |
| `refresh_tokens`             | UUIDv7 ID, family ID, predecessor ID, token hash, state, issued/rotated times                                                                                              | Partial unique index: one `ISSUED` per family                                    |
| `recovery_cases`             | UUIDv7 ID, kind (recovery or contact change), account ID (null for decoys), tier, state, proof flags, sealed pending contact, cooling-off end, expiry, end reason, version | Partial unique index: one open case per account                                  |
| `recovery_case_transitions`  | UUIDv7 ID, case ID, from/to, actor class, reason code, time                                                                                                                | Append-only                                                                      |
| `account_restrictions`       | UUIDv7 ID, account ID, kind, source case ID, starts/ends times, lifted time                                                                                                | Kind from a constrained list; never deleted                                      |
| `provider_callback_receipts` | UUIDv7 ID, provider alias, callback kind, provider event ID, received time, outcome code                                                                                   | Unique `(provider alias, callback kind, provider event ID)`                      |
| `rate_limit_buckets`         | dimension code, 32-byte subject commitment, window start, count                                                                                                            | Primary key `(dimension, subject, window start)`; atomic increment               |

Status columns use constrained text plus `CHECK` constraints, as in Phase 1.
Transition rows are append-only; guarded commands change status.

### 5.2 Contact point lifecycle

States: `ACTIVE`, `REPLACED` (terminal), `REVOKED` (terminal).

| From     | To         | Actor                          | Preconditions                                                |
| -------- | ---------- | ------------------------------ | ------------------------------------------------------------ |
| none     | `ACTIVE`   | registration or contact change | Unconsumed contact proof for the same fingerprint; index won |
| `ACTIVE` | `REPLACED` | recovery or contact change     | Successor contact inserted in the same transaction           |
| `ACTIVE` | `REVOKED`  | account closure handler        | Account `CLOSED`                                             |

A replaced or revoked contact keeps its fingerprint row for history but no longer
participates in the uniqueness index. The number may then bind to another account
only through a new verified proof.

### 5.3 Verification challenge lifecycle

States: `PENDING`, `VERIFIED`, `CONSUMED`, `EXPIRED`, `EXHAUSTED`, `CANCELLED`.

- `PENDING -> VERIFIED` on a correct code before expiry and within the attempt
  budget. It creates exactly one contact proof.
- `VERIFIED -> CONSUMED` when the proof is used.
- `PENDING -> EXHAUSTED` when failed attempts reach the cap.
- `PENDING|VERIFIED -> EXPIRED` at expiry.
- `PENDING -> CANCELLED` when a newer challenge supersedes it for the same
  destination and purpose.
- Every other edge is rejected. Terminal states never reopen.

### 5.4 Session family and refresh token lifecycle

Family states: `ACTIVE`, `REVOKED` (terminal), `EXPIRED` (terminal).
Revoke reasons: `LOGOUT`, `USER_REVOKED`, `REUSE_DETECTED`, `ACCOUNT_STATE`,
`RECOVERY`, `CONTACT_CHANGED`, `PASSWORD_CHANGED`, `SECURITY_POLICY`.

Refresh token states: `ISSUED`, `ROTATED`, `REVOKED`.

- Presenting an `ISSUED` token rotates it to `ROTATED`, issues one successor
  `ISSUED` token, and issues a new session.
- Presenting a `ROTATED` token inside the grace window (§9.3) is a retry, not
  theft, only when every grace condition holds.
- Presenting a `ROTATED` token outside grace, or a token of a revoked family,
  revokes the family with `REUSE_DETECTED`.

### 5.5 Recovery case lifecycle

States: `OPEN`, `AWAITING_PROOFS`, `COOLING_OFF`, `COMPLETED`, `REJECTED`,
`CANCELLED`, `EXPIRED`. The last four are terminal.

| From                      | To                | Actor                    | Preconditions                                                      |
| ------------------------- | ----------------- | ------------------------ | ------------------------------------------------------------------ |
| none                      | `OPEN`            | recovery requester       | Rate limits pass; no other open case for the account               |
| `OPEN`                    | `AWAITING_PROOFS` | recovery service         | Tier determined from available factors                             |
| `AWAITING_PROOFS`         | `COOLING_OFF`     | recovery service         | Every proof the tier requires is accepted                          |
| `AWAITING_PROOFS`         | `REJECTED`        | recovery service         | Re-verification mismatch or failed final proof                     |
| `COOLING_OFF`             | `COMPLETED`       | worker after cooling-off | Cooling-off elapsed; not cancelled; account not `SUSPENDED/CLOSED` |
| `COOLING_OFF`             | `CANCELLED`       | holder of old contact    | Valid cancel proof from the current contact or an active session   |
| `OPEN`, `AWAITING_PROOFS` | `CANCELLED`       | recovery service         | A newer recovery start for the same account (`SUPERSEDED`)         |
| any non-terminal          | `EXPIRED`         | worker                   | Case expiry elapsed                                                |

## 6. Phone normalization contract (`e164-v1`)

The profile identifier `e164-v1` is immutable. The algorithm is exact:

1. Accept a string of at most 32 Unicode scalar values. Reject other types and
   longer input first.
2. Reject Unicode control characters (`UNSUPPORTED_CHARACTER`).
3. Remove only U+0020 SPACE, U+002D HYPHEN-MINUS, U+0028 and U+0029 parentheses,
   and U+002E FULL STOP.
4. A non-ASCII Unicode decimal digit yields `NON_ASCII_DIGIT`. Any other
   character except a single leading `+` and ASCII digits yields
   `UNSUPPORTED_CHARACTER`.
5. If the result has no leading `+`: when a default calling code is configured
   and the digit count equals that code's configured national number length,
   prefix `+` and the code; when no default is configured, return
   `MISSING_CALLING_CODE`; otherwise return `INVALID_LENGTH`.
6. The digits after `+` must number 8 to 15 (`INVALID_LENGTH`).
7. The calling code is the longest configured prefix of the digits. No match
   yields `UNSUPPORTED_REGION`. The remaining national number must have the
   configured length for that code (`INVALID_LENGTH`). Where the configuration
   lists national destination codes (for `1`: national length `10`, codes `809`,
   `829`, `849`), the national number must start with one of them
   (`UNSUPPORTED_REGION`).
8. The canonical value is the ASCII string `+` followed by the digits.

No Unicode normalization, locale-sensitive parsing, or digit conversion occurs.
The allowlist is configuration, not code, so a second market adds codes without a
code change. Format validity never proves possession; only a verified challenge
does.

### 6.1 Required normalization vectors

The vectors use the reserved fictional `555-01XX` range and two configurations:

- **A**: allow calling code `1`, national length `10`, destination codes `809`,
  `829`, `849`, default calling code `1`.
- **B**: A without a default calling code.

| Input                          | Config | Result         | Code                    |
| ------------------------------ | ------ | -------------- | ----------------------- |
| `+18095550100`                 | A      | `+18095550100` | `OK`                    |
| `+1 (809) 555-0100`            | A      | `+18095550100` | `OK`                    |
| `809.555.0100`                 | A      | `+18095550100` | `OK`                    |
| `8095550100`                   | B      | none           | `MISSING_CALLING_CODE`  |
| `+12125550100`                 | A      | none           | `UNSUPPORTED_REGION`    |
| `+448095550100`                | A      | none           | `UNSUPPORTED_REGION`    |
| `+1809555010`                  | A      | none           | `INVALID_LENGTH`        |
| `+1809555010012345`            | A      | none           | `INVALID_LENGTH`        |
| `+1８０９5550100` (full-width) | A      | none           | `NON_ASCII_DIGIT`       |
| `+1809/5550100`                | A      | none           | `UNSUPPORTED_CHARACTER` |
| empty or spaces only           | A      | none           | `INVALID_LENGTH`        |
| more than 32 scalar values     | A      | none           | `INPUT_TOO_LONG`        |

## 7. Contact protection contracts

### 7.1 Contact fingerprint

HMAC-SHA-256 with a uniformly random 256-bit key held outside PostgreSQL. The
input is the UTF-8 bytes of these fields joined by one NUL byte:

```text
trayvi.auth-contact-fingerprint
normalization_profile
channel
canonical_value
```

Synthetic vector (forbidden outside tests):

```text
key hex:
404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f

fields:
trayvi.auth-contact-fingerprint
e164-v1
PHONE
+18095550100

joined input UTF-8 hex:
7472617976692e617574682d636f6e746163742d66696e6765727072696e7400653136342d76310050484f4e45002b3138303935353530313030

expected HMAC-SHA-256 hex:
cee3593473f50dd0bc86721df094a11e4023d5d984334ecb907b35daec322125
```

The contact fingerprint key is separate from the Phase 1 document fingerprint,
envelope, and idempotency keys. Key purposes are enforced at load time: the same
key bytes configured for two purposes fail startup (the Phase 1 `P1-AUD-004`
lesson). Rotation uses the Phase 1 dual-alias protocol (ADR-012 §8.2) with its
own keyring.

### 7.2 Contact envelope

The canonical number is stored only to send security notices and recovery
messages. It uses AES-256-GCM envelope encryption with a per-record DEK wrapped
by a KEK distinct from Identity's.

```text
DEK hex:    808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f
nonce hex:  0c0d0e0f1011121314151617
plaintext:  +18095550100
AAD UTF-8:  trayvi.auth-contact-envelope|v1|contact=018f0000-0000-7000-8000-0000000000b1|channel=PHONE|normalization=e164-v1
ciphertext: e998d3dddde7baf976b1efc4
tag:        d839844bdf102b3ad3664a0f1465b77e
```

Tests must decrypt the vector and reject changed ciphertext, tag, nonce, AAD
field, or key.

### 7.3 Challenges do not store the destination

A challenge stores only the destination fingerprint. The plaintext number lives
in memory while the delivery port sends the code and is then dropped. Sign-in
does not need the stored envelope; the caller supplies the number.

## 8. OTP and verification challenge contract

### 8.1 Generation and storage

- Codes are 6 ASCII decimal digits drawn uniformly from a CSPRNG using rejection
  sampling. Modulo-biased generation is forbidden.
- The stored value is a keyed commitment, never the code: HMAC-SHA-256 under the
  OTP commitment key over the NUL-joined fields
  `trayvi.auth-otp-commitment`, `otp-v1`, challenge ID, purpose, code.
- Verification recomputes the commitment and compares with a constant-time
  function.

Synthetic vector:

```text
key hex:
606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f

fields:
trayvi.auth-otp-commitment
otp-v1
018f0000-0000-7000-8000-0000000000a1
CONTACT_PROOF
042817

expected HMAC-SHA-256 hex:
9c765af2d9a4d0e3db10e11191e28b3dd71b8cc58a7759c13f9f10a4d7c508f1
```

### 8.2 Policy defaults

Defaults are configuration with validated bounds; production values need Trust &
Safety approval (§19.2).

| Parameter                     | Default    | Allowed range  |
| ----------------------------- | ---------- | -------------- |
| Code lifetime                 | 5 minutes  | 2–10 minutes   |
| Failed attempts per challenge | 5          | 3–10           |
| Resends per challenge         | 3          | 0–5            |
| Resend cooldown               | 30 seconds | 15–120 seconds |
| Contact proof lifetime        | 10 minutes | 2–15 minutes   |

### 8.3 Purposes

Each challenge has exactly one purpose: `CONTACT_PROOF` (sign-in or
registration), `STEP_UP`, `RECOVERY_NEW_CONTACT`, `RECOVERY_CANCEL`,
`CONTACT_CHANGE_NEW`. A proof for one purpose is rejected for every other
purpose. A proof is also bound to the installation commitment of the device that
started the challenge.

### 8.4 Enumeration safety

Starting a `CONTACT_PROOF` challenge does not depend on whether an account
exists. Registered, unregistered, and rate-limit-silenced numbers return the same
`202` envelope. Only after a correct code does the response tell the proven
holder whether an account exists for that number. Possession is the
authorization to learn that fact.

## 9. Sessions and tokens

### 9.1 Token format

- Access tokens are `tva_` plus base64url of 32 CSPRNG bytes; refresh tokens use
  `tvr_`; contact proofs use `tvp_`. Prefixes let secret scanners detect leaks.
- PostgreSQL stores only `SHA-256(token UTF-8)`. These tokens carry 256 bits of
  entropy, so an unkeyed hash does not create an offline guessing oracle (unlike
  phone numbers or documents).
- Tokens travel only in the `Authorization: Bearer` header or a JSON body. They
  never appear in URLs, logs, or events.

Synthetic vector: token
`tvr_oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8` (bytes `a0..bf`) has SHA-256
`c6aab7bdc67b337b613418b31f3f0eb5b91669970a9360654d032b3070ffdc95`.

Access tokens are opaque and checked against PostgreSQL on every request. This
makes revocation immediate and avoids a signing-key lifecycle. ADR-013 records
this choice and when to revisit it (measured lookup cost).

### 9.2 Lifetimes

| Parameter                | Default    | Notes                                               |
| ------------------------ | ---------- | --------------------------------------------------- |
| Access token             | 10 minutes | A new session per rotation                          |
| Family idle timeout      | 30 days    | Reset by each successful rotation                   |
| Family absolute lifetime | 90 days    | Never extended                                      |
| Recent-auth window       | 5 minutes  | Default for step-up checks; operations may lower it |

### 9.3 Rotation and reuse

Rotation runs in one transaction that locks the family row. The successor token
and new session commit together with the predecessor's `ROTATED` state.

A `ROTATED` token is accepted as a retry, without revoking the family, only when
all of these hold: it was rotated at most 30 seconds ago; it is the immediate
predecessor of the current `ISSUED` token; that successor has never been used;
and the request carries the same installation commitment. The retry revokes the
unused successor and issues a fresh one. Any other reuse revokes the family.

### 9.4 Principal and guard

Every route is authenticated unless it is on an explicit public allowlist
(health, challenge start/resend/verify, registration, session creation, refresh,
recovery start, recovery cancel, provider callbacks). Case-handle routes are
authenticated by the `tvc_` handle in the `Authorization: Case` header instead of
a principal. The guard resolves:

```text
accountId, sessionId, familyId, authenticatedAt, assurance (AAL1|AAL2),
factors, accountStatus, accountVersion, restrictions[]
```

It denies `SUSPENDED` and `CLOSED` accounts on every request, so suspension is
effective before any revocation job runs. `PENDING_IDENTITY` and `RESTRICTED`
principals authenticate but carry their state for later phases to evaluate. The
guard makes no permission decision; Phase 3 does.

`requireRecentAuthentication(maxAge, minAssurance)` returns
`STEP_UP_REQUIRED` when the family's last factor verification is older than
`maxAge` or the assurance is too low.

## 10. Password credential

- Optional. When an account has an active password, sign-in requires the contact
  proof and the password, producing `AAL2`. Without one, sign-in is `AAL1`.
- Hashing uses `scrypt` from Node's crypto module, with `N = 2^17`, `r = 8`,
  `p = 1`, a 16-byte random salt, and a 32-byte output, recorded under parameter
  version `scrypt-v1`. ADR-013 may choose Argon2id instead once the runtime or a
  reviewed dependency provides it. A verified login under old parameters
  rehashes.
- Policy: 12–128 characters, no composition rules, NFC normalization before
  hashing, rejection through a `CompromisedPasswordChecker` port (a synthetic
  list in Phase 2).
- Failed password attempts share the rate limiter: per account and per network.
  Failures never reveal whether the contact proof or the password was wrong.
- Setting or changing a password requires `AAL1` recent authentication within
  5 minutes, revokes every other family with `PASSWORD_CHANGED`, and emits an
  old-contact security notice.

## 11. Rate limiting and brute force

Rate limits are PostgreSQL buckets keyed by an HMAC commitment of the subject
under a dedicated rate-limit key, so stored rows reveal no phone or IP. An
increment is one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.

| Dimension                           | Default limit                           | Applies to                      |
| ----------------------------------- | --------------------------------------- | ------------------------------- |
| Contact fingerprint                 | 5 challenge starts/hour, 10/day         | challenge start                 |
| Network prefix (/24 IPv4, /56 IPv6) | 30 challenge starts/hour                | challenge start, recovery start |
| Installation commitment             | 10 challenge starts/hour                | challenge start                 |
| Contact fingerprint                 | 10 failed verifications/day             | challenge verify                |
| Account                             | 5 failed passwords/15 min, then backoff | sign-in with password           |
| Account                             | 3 recovery starts/day                   | recovery start                  |
| Contact fingerprint                 | 3 registration starts/30 days           | registration start              |
| Network prefix                      | 10 registration starts/day              | registration start              |
| Global                              | configured delivery budget/minute       | delivery port                   |

When a contact-dimension limit is reached, challenge start still returns the
generic `202` but sends nothing. Network and installation limits return
`RATE_LIMITED`; that response does not depend on any account. Given 5 attempts
per challenge and 10 failed verifications per number per day, an attacker's
chance of guessing one number's code is at most `10 / 10^6` per day; tests
assert this bound.

## 12. Registration binding

The Phase 1 enrollment flow is extended, not replaced:

1. The caller completes a `CONTACT_PROOF` challenge.
2. `StartAccountCreation` requires the contact proof. The proof is consumed in the
   same transaction that creates the enrollment operation.
3. When `SubmitIdentityInformation` creates the account, the same transaction
   inserts the `ACTIVE` primary contact point for the proven fingerprint.
4. If the number is already bound, the contact insert loses the partial unique
   index, the whole transaction rolls back, and the caller receives the same
   generic outcome Phase 1 uses for a duplicate document. The response directs to
   sign-in or recovery without confirming either.
5. The submission response stays Phase 1's generic envelope (P1-AC-026). It
   carries no tokens, because tokens only on success would reveal a duplicate
   document. The client then signs in with a new contact proof, and the session
   carries `accountStatus = PENDING_IDENTITY`.

Sign-in still reveals, after the fact, whether the account was created. A caller
who controls one phone number can therefore learn whether a document number is
already registered. Phase 1 already permits this signal to the holder of a
verified contact; Phase 2 bounds it with registration limits per contact (3 per
30 days) and per network (10 per day). The residual risk is recorded in §18, and
its acceptance is a Trust & Safety decision (§19.2).

A duplicate document (Phase 1 `CLAIM_ALREADY_BLOCKING`) produces an opaque
recovery-candidate reference. Phase 2 recovery accepts it as a Tier 3 entry
point. It never reveals the existing account.

## 13. Recovery

### 13.1 Tiers

| Tier | Situation                               | Required proofs                                                                               | Cooling-off | Post-recovery restriction |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- | ------------------------- |
| 0    | New device, same number                 | Normal sign-in. Not a recovery case.                                                          | none        | none                      |
| 1    | Forgot password, still holds the number | OTP to current contact; trusted re-verification if the identity is established                | 24 hours    | 72 hours                  |
| 2    | Lost the number                         | OTP to new number; trusted re-verification matching the established identity; password if set | 72 hours    | 7 days                    |
| 3    | Phase 1 duplicate-document candidate    | Same as Tier 2, entered through the opaque candidate reference                                | 72 hours    | 7 days                    |

An account whose identity is not `ESTABLISHED` cannot complete Tier 2 or 3: there
is nothing trusted to re-verify against. Such cases end `REJECTED` with a generic
outcome; the person must wait for Phase 3 governed review.

### 13.2 Controls

- Starting recovery returns a generic accepted response whether or not the number
  or candidate reference maps to an account.
- During cooling-off, the old contact (if any) receives a security notice with a
  cancel path, and any active session of the account can cancel the case.
- Completion runs in one transaction: replace the contact (Tier 2–3) or remove the
  password (Tier 1), revoke every family with `RECOVERY`, insert restrictions,
  write transitions, and enqueue outbox events.
- Restrictions apply until expiry:

  | Completed case     | Restrictions                                   |
  | ------------------ | ---------------------------------------------- |
  | Recovery, any tier | `HIGH_RISK_ACTIONS`, `CONTACT_CHANGE_BLOCKED`  |
  | Contact change     | `HIGH_RISK_ACTIONS`, `PASSWORD_CHANGE_BLOCKED` |

  `HIGH_RISK_ACTIONS` is the kind later phases (payouts, balance withdrawal) must
  check through the principal. No restriction ever blocks recovery: the owner
  must always be able to take the account back, and the re-verification
  requirement stops an attacker from bouncing it back again.

- A new recovery start supersedes an open case that is still `AWAITING_PROOFS`
  (it becomes `CANCELLED` with reason `SUPERSEDED`). A case in `COOLING_OFF` can
  only be cancelled by the owner. The per-account start limit bounds the
  resulting lockout risk.
- Unknown numbers and references get a decoy case that follows the same steps.
  Its re-verification can never match, so it ends `REJECTED` like a real
  mismatch. This keeps recovery from becoming an existence oracle for numbers
  the caller does not hold.
- Recovery never changes Phase 1 identity or document state.

### 13.3 Authenticated contact change

An authenticated holder may change the primary number. It requires recent `AAL2`
or, without a password, recent `AAL1` plus trusted re-verification; an OTP to the
new number; and a 24-hour cooling-off with old-contact notice and cancel. It
applies the same 72-hour restriction and revokes other families with
`CONTACT_CHANGED`.

## 14. Provider ports and callbacks

| Port                         | Direction | Purpose                                         | Phase 2 adapter  |
| ---------------------------- | --------- | ----------------------------------------------- | ---------------- |
| `OtpDeliveryPort`            | outbound  | Send OTP and security notices by SMS/WhatsApp   | synthetic        |
| `CompromisedPasswordChecker` | outbound  | Reject known-breached passwords                 | synthetic list   |
| `IdentityReverificationPort` | outbound  | Ask a provider to match a presenter to identity | synthetic        |
| Delivery-status callback     | inbound   | Delivered/failed status for a sent message      | synthetic signer |
| Re-verification callback     | inbound   | Provider decision for a re-verification case    | synthetic signer |

Inbound callbacks use `POST /api/v1/provider-callbacks/{providerAlias}/{kind}`:

- The body is at most 16 KiB and is verified before parsing.
- The signature is HMAC-SHA-256 over `timestamp + "." + raw body` with a
  per-provider secret from configuration. Timestamps more than 5 minutes from
  server time are rejected.
- A receipt row unique on `(providerAlias, kind, providerEventId)` makes
  processing idempotent. Replays return `200` with no new effect.
- Unknown providers, bad signatures, and stale timestamps all return the same
  `401` Problem Details. No detail distinguishes them.
- Only the parsed, allowlisted fields persist. Raw payloads are not retained.

## 15. Conceptual operations and API

| Operation                         | Route                                                    | Caller                   |
| --------------------------------- | -------------------------------------------------------- | ------------------------ |
| Start challenge                   | `POST /api/v1/verification-challenges`                   | public                   |
| Resend code                       | `POST /api/v1/verification-challenges/{id}/resend`       | public                   |
| Verify code                       | `POST /api/v1/verification-challenges/{id}/verify`       | public                   |
| Register (start account creation) | `POST /api/v1/account-registrations`                     | holder of contact proof  |
| Submit identity information       | `POST /api/v1/account-registrations/{id}/identity`       | holder of operation      |
| Sign in                           | `POST /api/v1/sessions`                                  | holder of contact proof  |
| Refresh                           | `POST /api/v1/sessions/refresh`                          | holder of refresh token  |
| Sign out                          | `DELETE /api/v1/sessions/current`                        | principal                |
| List own sessions                 | `GET /api/v1/sessions`                                   | principal                |
| Revoke one session family         | `DELETE /api/v1/sessions/{familyId}`                     | principal                |
| Revoke other families             | `POST /api/v1/sessions/revoke-others`                    | principal                |
| Start or verify step-up           | `POST /api/v1/sessions/current/step-up[/{id}/verify]`    | principal                |
| Own account state                 | `GET /api/v1/accounts/me`                                | principal                |
| Set or change password            | `PUT /api/v1/credentials/password`                       | principal + step-up      |
| Start recovery                    | `POST /api/v1/recovery-cases`                            | public                   |
| Recovery new-contact challenge    | `POST /api/v1/recovery-cases/challenges`                 | holder of case handle    |
| Submit recovery proof             | `POST /api/v1/recovery-cases/proofs`                     | holder of case handle    |
| Cancel challenge to old contact   | `POST /api/v1/recovery-cases/cancel-challenges`          | public                   |
| Cancel recovery                   | `POST /api/v1/recovery-cases/cancel`                     | old contact or principal |
| Contact-change challenge          | `POST /api/v1/contact-changes/challenges`                | principal                |
| Start contact change              | `POST /api/v1/contact-changes`                           | principal + step-up      |
| Provider callback                 | `POST /api/v1/provider-callbacks/{providerAlias}/{kind}` | signed provider          |

Stable public Problem Details codes:

```text
CHALLENGE_ACCEPTED
INVALID_CONTACT_FORMAT
VERIFICATION_FAILED
CHALLENGE_NOT_ACTIVE
AUTHENTICATION_FAILED
AUTHENTICATION_REQUIRED
REAUTHENTICATION_REQUIRED
STEP_UP_REQUIRED
ACTION_RESTRICTED
RECOVERY_ACCEPTED
IDEMPOTENCY_CONFLICT
REQUEST_CANNOT_BE_COMPLETED
RATE_LIMITED
CALLBACK_REJECTED
INVALID_REQUEST
```

`INVALID_REQUEST` is the Foundation code for a request that fails its schema; it
depends only on the request's shape. `VERIFICATION_FAILED` covers a wrong, expired, or exhausted code without saying
which. `AUTHENTICATION_FAILED` covers every sign-in failure.

## 16. Events

Outbox events carry opaque IDs, safe state/reason codes, policy versions,
occurred-at, and correlation/causation IDs only:

```text
auth.contact.bound          auth.contact.replaced
auth.session.created        auth.session.family-revoked
auth.session.reuse-detected auth.password.changed
auth.recovery.opened        auth.recovery.cooling-off-started
auth.recovery.cancelled     auth.recovery.completed
auth.recovery.rejected      auth.restriction.applied
```

No event carries a phone number, fingerprint, OTP, token, token hash, password
material, network address, or provider payload.

## 17. Privacy and data classification

| Data                              | Class                          | Purpose                             | Permitted readers          | Retention baseline (needs approval)     | Forbidden propagation                  |
| --------------------------------- | ------------------------------ | ----------------------------------- | -------------------------- | --------------------------------------- | -------------------------------------- |
| Phone number in memory            | Restricted                     | normalize, fingerprint, send        | Auth use case only         | drop after request                      | logs, traces, metrics, events, URLs    |
| Contact envelope                  | Restricted                     | security notices, recovery messages | Auth crypto workload       | while bound; crypto-erase after closure | reporting/support roles, events        |
| Contact fingerprint               | Restricted security derivative | uniqueness, rate limits, challenge  | Auth repositories          | active and post-closure window          | responses, telemetry, events           |
| OTP code                          | Restricted secret              | possession proof                    | delivery port only         | never persisted                         | everything except the delivery request |
| OTP commitment                    | Restricted                     | verification                        | Auth challenge repository  | challenge lifetime + 24 hours           | everything                             |
| Password hash and salt            | Restricted secret              | knowledge factor                    | Auth credential repository | while active; delete on replace         | everything                             |
| Token hashes                      | Restricted secret derivative   | token lookup                        | Auth session repository    | family lifetime + 30 days               | everything                             |
| Installation commitment           | Confidential                   | proof binding, rate limits          | Auth                       | family lifetime                         | events, analytics                      |
| Network-prefix commitment         | Confidential                   | rate limits                         | rate limiter               | window length                           | everything                             |
| Recovery case state and flags     | Confidential                   | recovery governance                 | Auth; Phase 3 reviewers    | case + approved audit window            | public events beyond safe codes        |
| Provider event ID, alias, outcome | Internal                       | idempotent callbacks                | Auth                       | 90 days                                 | analytics at row level                 |

Every column receives a full inventory entry before production (P2-AC-037).

## 18. Threat model

| Threat                               | Attack                                          | Controls                                                                                            | Residual risk and proof                                                      |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OTP brute force                      | guess 6-digit codes                             | per-challenge cap, per-number daily cap, network/installation limits, constant-time compare         | bounded `10/10^6` per number per day; simulation test                        |
| Account enumeration                  | compare responses for known/unknown numbers     | account-independent challenge start, generic failures, same envelope                                | timing noise; statistical status/size/timing comparison                      |
| SMS pumping / toll fraud             | trigger mass sends to premium numbers           | region allowlist, per-network and global delivery budget                                            | provider-side controls needed in production                                  |
| SIM swap                             | attacker takes over the number                  | optional password → `AAL2`; recovery cooling-off and old-contact notice; post-recovery restrictions | accounts without password stay exposed; product decision (§19.2)             |
| Refresh token theft                  | replay a stolen refresh token                   | single-use rotation, family reuse detection, installation binding in grace                          | theft before first rotation; short access lifetime limits the window         |
| Access token theft                   | replay a stolen access token                    | 10-minute lifetime, server-side check, revocation                                                   | use within lifetime; Phase 3 device signals                                  |
| Concurrent refresh race              | duplicate rotations from retries                | family row lock, partial unique index on `ISSUED`, grace rule                                       | 100-way race evidence                                                        |
| Session fixation                     | inject a known token                            | server-generated tokens only; new family per sign-in                                                | none known                                                                   |
| Revocation lag                       | use a token after logout or suspension          | per-request PostgreSQL check, no token cache                                                        | in-flight request at revocation time                                         |
| Password guessing / stuffing         | try passwords across accounts                   | password only after contact proof, per-account and network limits, breached-list check              | distributed attacks; production WAF/bot controls                             |
| Recovery takeover                    | use recovery to steal an account                | tiers, trusted re-verification, cooling-off, cancel path, restrictions                              | identity provider strength; production provider choice                       |
| Recovery lockout (denial of service) | open cases to block the owner                   | one open case per account, cancel by owner, rate limits, expiry                                     | owner without old contact and session; Phase 3 review                        |
| Forged provider callback             | post fake verification or delivery events       | HMAC signature, timestamp window, receipt uniqueness, generic `401`                                 | provider secret compromise; rotation runbook                                 |
| Callback replay                      | resend a captured valid callback                | unique receipt, timestamp window                                                                    | none within window; replay returns no new effect                             |
| Log/trace leakage                    | phone, OTP, token, password captured            | typed redaction, `tva_/tvr_/tvp_` scanner patterns, canary tests                                    | third-party agents; production sink review                                   |
| Database dump                        | read tokens, phones, passwords                  | token hashes only, contact envelope, scrypt, restricted grants                                      | metadata exposure; least-privilege grants evidence                           |
| Contact-binding race                 | two accounts bind the same number               | partial unique index, single transaction                                                            | 50-way race evidence                                                         |
| Document-registration oracle         | register a victim's document, then test sign-in | generic Phase 1 submission response, registration limits per contact and network                    | High until Trust & Safety accepts or a design removes it; production blocker |
| Insider session minting              | staff creates sessions directly                 | no staff route; runtime role cannot insert families without the guarded function                    | DB administrators; Phase 3 audit                                             |

No Critical or High residual risk is accepted silently. Each one that needs
Phase 3, a provider, or governance is an explicit production blocker.

## 19. Open decisions

### 19.1 Engineering

- Shared crypto extraction: keep a private Auth adapter (default) or extract a
  reviewed `packages/crypto` used by Identity and Auth. ADR-013 decides; no
  extraction without it.
- `scrypt-v1` versus Argon2id. The default is `scrypt-v1` because it needs no new
  native dependency on Node 22.
- Whether access-token checks need a cache once load is measured. The default is
  no cache, so revocation stays immediate.

### 19.2 Product and Trust & Safety

- Whether drivers (Phase 5) must set a password (`AAL2`) before going online.
  Recommended: yes.
- OTP lifetime, attempt, resend, cooling-off, and restriction durations.
- Message templates and languages (`es-DO` first) for OTP and security notices.
- Whether WhatsApp is offered alongside SMS.
- Accept or remove the document-registration oracle (§12, §18), and whether
  onboarding may skip the second OTP after identity submission.

### 19.3 Legal and regulatory

- Lawful basis, notice, and retention for phone numbers, session metadata, and
  network-prefix commitments.
- Telecom and messaging consent rules in the Dominican Republic.

### 19.4 Provider

- SMS/WhatsApp provider, sender registration, delivery-status callbacks, and
  fraud controls.
- Identity re-verification provider and assurance level.
- Callback secret custody and rotation.

The safe default is synthetic adapters only, no real messages, and no real
re-verification. These decisions block production, not a synthetic
implementation.

## 20. Migration plan

No migration is created by this plan. Phase 1 remediation reserves `0008`–`0010`
and its privilege-boundary follow-up (issue #6) reserves `0011`, so Phase 2
starts at `0012`. Each spec confirms its numbers when it becomes `approved`.

| Order  | Spec     | Contents                                                              |
| ------ | -------- | --------------------------------------------------------------------- |
| `0012` | SPEC-001 | `auth` schema, usage grants (integration scaffold)                    |
| `0013` | SPEC-001 | contact points, transitions, guards                                   |
| `0014` | SPEC-001 | verification challenges, contact proofs                               |
| `0015` | SPEC-001 | rate-limit buckets                                                    |
| `0016` | SPEC-001 | provider callback receipts                                            |
| `0017` | SPEC-002 | session families, sessions, refresh tokens, guarded rotation function |
| `0018` | SPEC-002 | password credentials                                                  |
| `0019` | SPEC-002 | enrollment-operation contact binding (Accounts)                       |
| `0020` | SPEC-003 | recovery cases, transitions, account restrictions                     |
| `0021` | SPEC-003 | identity re-verification case method (Identity)                       |

Every migration has a paired down that refuses to drop populated tables, and the
evidence shows `up -> verify -> down -> up -> verify`, catalog grants, and
runtime-role denial tests.

## 21. Specs

| Spec                                                                       | Capability                                                          | Starts after                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| [SPEC-001](specs/SPEC-001-contact-verification-challenges/requirements.md) | Contact points, OTP challenges, rate limits, delivery and callbacks | Phase 1 `PASS`; this plan approved |
| [SPEC-002](specs/SPEC-002-sign-in-and-sessions/requirements.md)            | Sign-in, password, sessions, rotation, guard, registration binding  | SPEC-001 `integrated`              |
| [SPEC-003](specs/SPEC-003-account-recovery/requirements.md)                | Recovery tiers, re-verification, contact change, restrictions       | SPEC-002 `integrated`              |

Specs run in sequence because each one consumes the previous one's runtime code.
Streams inside each spec run in parallel.

## 22. Acceptance criteria

Every criterion blocks Phase 2 closure unless marked production only.

| ID        | Verifiable criterion                                                                                                                                                | Required evidence                          | Blocking        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| P2-AC-001 | Changes are limited to Auth, approved Accounts/Identity seams, composition, migrations, tests, and docs; no Phase 3+ capability is implemented.                     | changed-file manifest, architecture report | Phase 2 closure |
| P2-AC-002 | Auth uses domain/application/infrastructure direction; it reaches Accounts and Identity only through application ports.                                             | boundary check, dependency graph           | Phase 2 closure |
| P2-AC-003 | ADR-013 is accepted and the register links it.                                                                                                                      | ADR file and register diff                 | Phase 2 closure |
| P2-AC-004 | `e164-v1` follows the exact contract and every vector in §6.1.                                                                                                      | unit/property test report                  | Phase 2 closure |
| P2-AC-005 | Contact fingerprints reproduce the §7.1 vector, change under any field/key mutation, and use a key distinct from every other purpose.                               | crypto unit tests, startup rejection test  | Phase 2 closure |
| P2-AC-006 | The contact envelope reproduces the §7.2 vector and rejects every specified tampering.                                                                              | crypto unit tests                          | Phase 2 closure |
| P2-AC-007 | PostgreSQL allows one active contact per fingerprint scope and one active primary per account; 50 concurrent bindings × 10 rounds yield one winner each.            | catalog evidence, concurrency results      | Phase 2 closure |
| P2-AC-008 | OTPs are uniform 6-digit CSPRNG codes stored only as the §8.1 keyed commitment and compared in constant time.                                                       | unit tests, distribution test, schema scan | Phase 2 closure |
| P2-AC-009 | Challenge lifecycle enforces expiry, attempt cap, resend limits and cooldown, purpose and installation binding, and single consumption; illegal edges fail.         | transition matrix, direct-SQL negatives    | Phase 2 closure |
| P2-AC-010 | 50 concurrent correct verifications of one challenge yield one proof; concurrent wrong guesses never exceed the attempt cap.                                        | concurrency results                        | Phase 2 closure |
| P2-AC-011 | Rate limits in §11 are enforced atomically in PostgreSQL and store no plain phone or IP; the brute-force bound holds in simulation.                                 | integration and simulation report          | Phase 2 closure |
| P2-AC-012 | Challenge start responses for registered, unregistered, and contact-limited numbers match in status, schema, size class, and headers, with bounded timing.          | oracle comparison report                   | Phase 2 closure |
| P2-AC-013 | OTP delivery goes through a provider-neutral port; delivery failure yields a safe outcome; codes never reach logs, errors, or events.                               | adapter tests, canary capture              | Phase 2 closure |
| P2-AC-014 | Callbacks verify signature and timestamp before parsing, reject replays and forgeries with one generic response, process once, and keep no raw payload.             | callback test matrix                       | Phase 2 closure |
| P2-AC-015 | Sign-in consumes a contact proof once, honors purpose and installation binding, requires the password when one is active, and fails generically.                    | integration tests                          | Phase 2 closure |
| P2-AC-016 | Passwords use versioned `scrypt-v1` (or ADR-013's choice), the §10 policy, breached check, rate-limited failures, and rehash on upgrade.                            | unit/integration tests                     | Phase 2 closure |
| P2-AC-017 | Tokens are 256-bit CSPRNG values with prefixes, stored only as SHA-256 hashes, never in URLs, logs, or events; the §9.1 vector reproduces.                          | unit tests, schema scan, canary capture    | Phase 2 closure |
| P2-AC-018 | Access lifetime, idle timeout, and absolute lifetime are enforced server-side.                                                                                      | clock-controlled integration tests         | Phase 2 closure |
| P2-AC-019 | Refresh tokens are single use; reuse outside the §9.3 grace conditions revokes the family; grace retries never leave two `ISSUED` tokens.                           | transition matrix, integration tests       | Phase 2 closure |
| P2-AC-020 | 100 concurrent refreshes of one token × 10 rounds end with at most one `ISSUED` token and a consistent family each round.                                           | concurrency results                        | Phase 2 closure |
| P2-AC-021 | Sign-out, revoke one, revoke others, and revoke all take effect on the next request with no cache window.                                                           | integration tests                          | Phase 2 closure |
| P2-AC-022 | `SUSPENDED` and `CLOSED` accounts are denied on every request; `AccountSessionRevoker` revokes all families atomically with its caller.                             | integration tests                          | Phase 2 closure |
| P2-AC-023 | Every non-allowlisted route requires a principal; the principal carries assurance, auth time, state, and restrictions; no permission logic exists.                  | route inventory test, guard tests          | Phase 2 closure |
| P2-AC-024 | Step-up returns `STEP_UP_REQUIRED` when recent authentication or assurance is insufficient.                                                                         | guard tests                                | Phase 2 closure |
| P2-AC-025 | Registration requires a contact proof, binds the contact atomically with account creation, and returns Phase 1's generic outcome on contact or document duplicates. | integration and oracle tests               | Phase 2 closure |
| P2-AC-026 | Recovery follows the §13.1 tier matrix and never creates an account, identity, or second contact binding.                                                           | tier matrix tests, row-count assertions    | Phase 2 closure |
| P2-AC-027 | Tier 2–3 recovery requires new-contact OTP, trusted re-verification matching the original identity, and the password when set; mismatches end `REJECTED`.           | integration tests                          | Phase 2 closure |
| P2-AC-028 | Recovery completion atomically replaces contact or password, revokes all families, applies restrictions, and the principal exposes the restrictions.                | injected-failure and integration tests     | Phase 2 closure |
| P2-AC-029 | Recovery start is generic and rate limited; one open case per account; the owner can cancel during cooling-off; cases expire.                                       | integration and oracle tests               | Phase 2 closure |
| P2-AC-030 | Authenticated contact change requires step-up, new-contact OTP, cooling-off with old-contact notice, and applies restrictions.                                      | integration tests                          | Phase 2 closure |
| P2-AC-031 | Every state change, transition row, and outbox event commits atomically or leaves no orphan.                                                                        | injected-failure matrix                    | Phase 2 closure |
| P2-AC-032 | Outbox events contain only allowlisted safe fields.                                                                                                                 | event contract tests                       | Phase 2 closure |
| P2-AC-033 | Canary phone, OTP, password, and tokens are absent from logs, traces, metrics, errors, events, and URLs.                                                            | canary capture and scans                   | Phase 2 closure |
| P2-AC-034 | New migrations follow existing ones, are immutable, pass up/down/up verification, and grant runtime roles only the narrow privileges each table needs.              | migration transcript, grants report        | Phase 2 closure |
| P2-AC-035 | Public errors use Problem Details and only the §15 codes; no response reveals account existence before possession is proven.                                        | API contract tests                         | Phase 2 closure |
| P2-AC-036 | Every threat in §18 maps to a test or an explicit production blocker.                                                                                               | threat register mapping                    | Phase 2 closure |
| P2-AC-037 | Every persisted field has classification, purpose, owner, readers/writers, retention, deletion, legal hold, event, and telemetry policy.                            | approved column inventory                  | Production only |
| P2-AC-038 | Retention for contacts, challenges, sessions, recovery cases, and callbacks follows an approved policy.                                                             | approval references, deletion drill        | Production only |
| P2-AC-039 | Real delivery and re-verification providers are selected, and callback secrets have custody and rotation.                                                           | provider decision records                  | Production only |
| P2-AC-040 | Fresh-checkout `verify:full` and all CI gates pass with no Phase 0 or Phase 1 regression.                                                                           | CI run ID, gate summary                    | Phase 2 closure |
| P2-AC-041 | Implementation report, evidence manifest, and an independent audit with no open Critical/High finding establish a final `PASS`.                                     | implementation and audit documents         | Phase 2 closure |

## 23. ADR required before implementation completion

### ADR-013 — Authentication, session, and recovery strategy

The number is reserved in the [ADR register](../../adr/README.md). It must
decide and record:

- phone contact points as the primary factor, `e164-v1`, and contact protection
  keys;
- OTP format, commitment, policy bounds, and purposes;
- opaque access tokens with server-side lookup, refresh rotation, the grace rule,
  and family revocation;
- password hashing algorithm and parameter versioning;
- assurance levels and step-up;
- recovery tiers, cooling-off, restrictions, and the Identity re-verification
  seam;
- callback authentication and idempotency;
- whether contact crypto is extracted into a shared package.

## 24. Definition of ready

The plan becomes ready for implementation when:

1. Phase 1 records a final `PASS`.
2. This plan is reviewed and its status changes to `READY`.
3. ADR-013 is at least `Proposed` with decisions matching this plan.
4. SPEC-001 is `approved`.

```text
PHASE 1 — NOT CLOSED (AUDIT FAIL; REMEDIATION PENDING RETEST)
PHASE 2 — PLAN — DRAFT
NO PHASE 2 IMPLEMENTATION BEGINS UNDER THIS DOCUMENT
```
