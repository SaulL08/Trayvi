# Phase 1 — Accounts and Identity — Plan

Status: READY FOR PHASE 1 IMPLEMENTATION — SEPARATE HUMAN AUTHORIZATION REQUIRED  
Planned phase: 1  
Scope owners: Accounts and Identity  
Last updated: 2026-09-10

## 1. Decision and scope

This document is the implementation contract for Phase 1. It plans the smallest
coherent account and person-identity foundation that can later support customer,
driver, merchant/business, and authorized internal roles without duplicating a
person or a base account.

The planning decision is:

```text
PHASE 1 — ACCOUNTS AND IDENTITY — PLAN
READY FOR PHASE 1 IMPLEMENTATION
SEPARATE HUMAN AUTHORIZATION REQUIRED BEFORE IMPLEMENTATION
```

This decision does not authorize implementation, migrations, API changes, or a
push. Phase 0 remains closed. `AC-031` remains deferred to pre-production
governance and is not reopened by this plan.

### 1.1 In scope for a later, separately authorized implementation

- The Accounts and Identity module boundaries and their dependency direction.
- A single base account linked one-to-one to a durable person identity.
- Protected national-document intake, normalization, encryption, keyed
  fingerprinting, and database-enforced uniqueness.
- Account, identity, verification-case, review, document, and fingerprint-claim
  lifecycles.
- Atomic, idempotent creation behavior under retries and concurrency.
- Provider-neutral verification evidence and a port through which a later phase
  can submit trusted outcomes.
- Privacy classification, access boundaries, retention hooks, deletion behavior,
  and safe observability rules.
- Conceptual operations, persistence model, migrations, tests, and evidence.
- ADR-011 and ADR-012 as required decisions before code is considered complete.

### 1.2 Explicitly out of scope

- Authentication, passwords, passkeys, OTP, sessions, tokens, login, logout,
  credential recovery, and account-takeover recovery. These belong to Phase 2.
- RBAC/ABAC, role assignment, permissions, support impersonation, emergency
  access, and the complete append-only audit control plane. These belong to
  Phase 3.
- Selection or integration of an identity-verification provider.
- Driver, customer, merchant, dispatch, trip, payment, ledger, or marketplace
  implementation.
- Biometrics engines, custom cryptographic algorithms, distributed identity,
  blockchain, event brokers, microservices, a full fraud engine, or a full admin
  system.
- Production collection of real identity data before legal basis, retention,
  deletion, data-subject handling, and key-custody owners are approved.
- Any Phase 2 implementation or plan.

## 2. Source constraints carried forward

The plan preserves these established decisions:

- Trayvi remains a modular monolith. A future extraction needs measured reasons;
  Phase 1 creates no microservice.
- Business modules depend on shared primitives, never on applications or
  infrastructure. Transport and infrastructure depend inward.
- PostgreSQL is authoritative for uniqueness and state invariants. Application
  checks improve diagnostics but are never the concurrency control.
- Identifiers exposed outside a module are opaque UUIDv7 values.
- Schema changes use ordered, immutable, reviewed SQL migrations. Runtime roles
  receive no DDL privileges.
- APIs use versioned contracts, safe Problem Details, and the repository's
  idempotency convention.
- State changes and safe integration events commit together through the
  transactional outbox.
- Raw identifiers and equivalently sensitive derivatives never enter logs,
  traces, metrics, URLs, event payloads, tokens, or analytics.
- Unit tests are complemented by real-PostgreSQL integration and concurrency
  tests.
- Trust signals are evidence, not silent verdicts. Material human decisions need
  an actor, reason, evidence reference, and visible outcome.

## 3. Ubiquitous language and ownership

| Concept               | Definition                                                                                                         | Owning module                                               | Must not own                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Person                | The real-world human; a domain referent, not a public identifier or a row asserting unproven legal truth.          | none; represented through governed Identity evidence        | Accounts, credentials, roles, or an automatic “verified” assertion         |
| Account               | The one base relationship through which a person can later act in multiple roles.                                  | Accounts                                                    | Credentials, sessions, document values, verification evidence, permissions |
| Person identity       | The durable record representing the person bound to exactly one account. It is not a login credential.             | Identity                                                    | Roles, sessions, provider SDK details                                      |
| Identity document     | A protected document assertion scoped by country, issuer, document type, and normalization version.                | Identity                                                    | Public profile data                                                        |
| Fingerprint claim     | A keyed, versioned equality alias that reserves or binds a document without storing a reversible digest.           | Identity                                                    | Authentication secrets                                                     |
| Verification case     | A provider-neutral assessment request and its outcome.                                                             | Identity                                                    | Phase 2 challenges or provider transport                                   |
| Verification evidence | Minimal structured metadata plus an opaque reference to restricted evidence.                                       | Identity                                                    | Raw evidence in events or general logs                                     |
| Review                | A governed human decision attached to a verification case.                                                         | Identity now; Phase 3 supplies authorization/audit controls | Silent overrides                                                           |
| Enrollment operation  | An idempotent orchestration record for creating the account/identity aggregate.                                    | Accounts                                                    | A second account on duplicate input                                        |
| Role attachment       | A future module-owned association from the single account to a customer, driver, merchant, or operator capability. | Future role modules / Authorization                         | A new base account or copied identity                                      |

### 3.1 Cardinality invariants

1. Every `person_identity` belongs to exactly one `account`.
2. An account has zero identity only during the bounded enrollment transaction;
   no committed account may be active without exactly one established identity.
3. `person_identities.account_id` is unique. A person identity cannot be shared
   across base accounts.
4. One identity may hold more than one document over time. Every blocking
   document claim is unique within its country/issuer/type/normalization/key
   scope.
5. A document cannot prove that two different document numbers belong to the
   same human. Cross-document linking requires trusted verification evidence;
   the system must not claim a stronger guarantee than it can enforce.
6. Future roles attach to `account_id`; they never create alternate account or
   identity rows for the same person.

## 4. Module and layer boundaries

A later implementation should introduce only these business roots:

```text
modules/
  accounts/
    domain/
    application/
    infrastructure/
  identity/
    domain/
    application/
    infrastructure/
```

The dependency direction is `domain <- application <- infrastructure`.
Applications such as `apps/api` and `apps/worker` compose the modules; they do
not contain domain rules.

Accounts owns account state, the account-to-identity reference, enrollment
operations, and account transition history. Identity owns protected document
material, fingerprints, verification cases, reviews, and identity transition
history. Neither module imports the other's infrastructure.

The account-creation use case is a composition-root application service with one
database unit of work. It calls narrow Accounts and Identity application ports
and commits both modules' writes, the idempotency result, and outbox messages in
one PostgreSQL transaction. This is an intentional in-process collaboration, not
a distributed transaction.

Required ports include:

- `DocumentNormalizer`
- `DocumentFingerprintKeyring`
- `DocumentFingerprinter`
- `DocumentEnvelopeEncryptor`
- `AccountRepository`
- `IdentityRepository`
- `VerificationEvidenceRepository`
- `UnitOfWork`
- `Clock` and `UuidV7Generator`
- existing idempotency and transactional-outbox abstractions

Cryptographic orchestration remains private to Identity. It must not become a
generic shared package until a second concrete owner demonstrates the correct
abstraction.

## 5. Domain model

### 5.1 Aggregate records

| Record                        | Essential fields                                                                                                                                  | Invariants                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `account_creation_operations` | opaque ID, idempotency binding, request hash, state, safe result code, timestamps, expiry                                                         | Unique caller/operation/key-hash tuple; same key with different request hash is rejected safely      |
| `accounts`                    | UUIDv7 ID, status, status reason code, version, created/updated/closed timestamps                                                                 | No `ACTIVE` account without one `ESTABLISHED` identity; optimistic version increments                |
| `account_status_transitions`  | UUIDv7 ID, account ID, from/to state, actor class/ref, reason code, evidence ref, timestamp                                                       | Append-only; exact predecessor state/version required                                                |
| `person_identities`           | UUIDv7 ID, unique account ID, status, status reason code, established/restricted/retired timestamps, version                                      | One row per account; no public document fields                                                       |
| `identity_status_transitions` | UUIDv7 ID, identity ID, from/to state, actor class/ref, reason code, evidence ref, timestamp                                                      | Append-only; exact predecessor state/version required                                                |
| `identity_documents`          | UUIDv7 ID, identity ID, scope fields, normalization version, encrypted envelope fields, state, created/superseded timestamps                      | No plaintext column; envelope metadata must be complete or absent only after approved crypto-erasure |
| `document_fingerprint_claims` | UUIDv7 ID, document ID, scope fields, normalization version, HMAC key version, 32-byte fingerprint, state, timestamps                             | Unique blocking claim; never returned or logged                                                      |
| `verification_cases`          | UUIDv7 ID, identity ID, method class, state, provider-neutral result code, opened/resolved/expiry timestamps                                      | Provider payloads do not enter this table                                                            |
| `verification_evidence`       | UUIDv7 ID, case ID, evidence type, issuer/provider alias, collected-at, digest/attestation metadata, restricted opaque reference, retention class | No raw document image/content in general storage or outbox                                           |
| `identity_reviews`            | UUIDv7 ID, case ID, state, actor ref, reason code, evidence ref, timestamps                                                                       | Material decisions cannot be applied without required reason/evidence                                |

Names are conceptual until ADR-011/012 and migration review accept them. Status
columns should use constrained text plus `CHECK` constraints rather than
PostgreSQL enum types, allowing expand/migrate/contract changes.

IDs, creation timestamps, original aggregate links, document scope/profile,
crypto algorithm/version metadata for a stored envelope or alias, evidence
digests/references, and transition rows are immutable. Status, safe reason,
aggregate version, and resolution timestamps are mutable only through guarded
domain transitions. Superseding a document, verification case, review, or
evidence record creates a linked successor; it never rewrites history.

### 5.2 Account lifecycle

Account states are:

- `PENDING_IDENTITY`: the document claim and identity exist, but trusted
  verification has not established the identity.
- `ACTIVE`: identity is established and the account may later receive roles.
- `RESTRICTED`: the relationship exists but policy limits permitted actions.
- `SUSPENDED`: use is stopped pending a material resolution.
- `CLOSED`: terminal business state. It is not physical deletion and does not
  release identity uniqueness by default.

| From                     | To                       | Authorized actor                             | Preconditions                                                                       | Required evidence and side effects                                  | Reversible                                   |
| ------------------------ | ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| none                     | `PENDING_IDENTITY`       | enrollment service                           | New blocking claim won atomically                                                   | identity/document/claims/outbox created in same transaction         | No; expire or close explicitly               |
| `PENDING_IDENTITY`       | `ACTIVE`                 | trusted verification outcome handler         | Identity is `ESTABLISHED`; review is `NOT_REQUIRED` or `APPROVED`; claim is `BOUND` | reason, case/evidence refs, transition, outbox                      | Yes, through governed restriction/suspension |
| `PENDING_IDENTITY`       | `CLOSED`                 | expiry policy or governed reviewer           | Verification expired, failed finally, or enrollment withdrawn                       | reason and evidence; claim disposition per retention policy         | No                                           |
| `ACTIVE`                 | `RESTRICTED`             | future Phase 3 authorized policy/reviewer    | Explicit policy reason                                                              | append transition/outbox; existing roles observe restriction        | Yes                                          |
| `RESTRICTED`             | `ACTIVE`                 | future Phase 3 authorized policy/reviewer    | Restriction resolved with evidence                                                  | append transition/outbox                                            | Yes                                          |
| `ACTIVE` or `RESTRICTED` | `SUSPENDED`              | future Phase 3 authorized policy/reviewer    | Material safety/security reason                                                     | append transition/outbox; later auth must deny use                  | Yes                                          |
| `SUSPENDED`              | `ACTIVE` or `RESTRICTED` | future Phase 3 authorized policy/reviewer    | Resolution determines target state                                                  | append transition/outbox                                            | Yes                                          |
| any non-closed state     | `CLOSED`                 | person request or future authorized reviewer | Closure policy and legal hold evaluated                                             | append transition/outbox; schedule approved deletion/crypto-erasure | No                                           |

Reopening `CLOSED` is forbidden in Phase 1. A later recovery/reactivation design
must decide whether to restore the same account; it must never silently create a
second one.

### 5.3 Identity, verification, review, document, and claim lifecycles

Identity states are `PENDING`, `ESTABLISHED`, `RESTRICTED`, and terminal
`RETIRED`. Only a resolved, trusted verification case plus review state
`NOT_REQUIRED` or `APPROVED` may transition `PENDING -> ESTABLISHED`.
`ESTABLISHED <-> RESTRICTED` and any non-retired state to `RETIRED` require an
authorized actor, reason, evidence reference, transition row, and outbox event.

Verification-case states are `PENDING`, `VERIFIED`, `FAILED`, `INCONCLUSIVE`,
`EXPIRED`, and `CANCELLED`. Terminal outcomes are immutable; a retry creates a
new case linked to the previous case instead of rewriting history.

Review states are `NOT_REQUIRED`, `QUEUED`, `IN_REVIEW`, `APPROVED`, `REJECTED`,
and `CANCELLED`. Only `QUEUED -> IN_REVIEW -> APPROVED|REJECTED` is a human
decision path. `NOT_REQUIRED` must be produced by an accepted policy version,
not an operator shortcut.

Document states are `CURRENT`, `SUPERSEDED`, `REVOKED`, and
`CRYPTOSHREDDED`. Claim states are:

- `RESERVED`: blocks duplicate enrollment while verification is pending.
- `BOUND`: blocks duplicates for an established or retained closed identity.
- `TOMBSTONED`: retains non-reversible uniqueness after permitted
  crypto-erasure.
- `ABANDONED`: releases a never-established reservation only under an approved
  anti-denial-of-service and retention policy.

No support or administrator path may update these status columns directly.
Transitions occur through guarded domain commands. PostgreSQL triggers or
constraint functions enforce the cross-row activation and transition-history
requirements in addition to application rules.

### 5.4 Evidence hooks and internal-actor constraints

The complete permission and audit control plane remains Phase 3. Phase 1 only
creates safe, immutable source evidence and outbox hooks for at least:

- `identity.created`
- `identity.duplicate-detected` (internal evidence only; never a public event)
- `identity.document-claimed`
- `identity.linked-to-account`
- `identity.established`
- `identity.restricted`
- `identity.manual-review-requested`
- `account.activated`
- `account.restricted`
- `account.suspended`
- `account.closed`

Event payloads contain opaque aggregate/event IDs, safe state/reason codes,
policy version, occurred-at, and correlation/causation IDs only. They never carry
document input, normalized value, fingerprint, envelope material, provider raw
payload, or idempotency secret.

A future operator cannot create a duplicate identity, replace a document
silently, merge accounts, release a blocking claim, or override uniqueness merely
because the operator “knows the customer.” Phase 1 exposes no direct support
mutation. A future exception requires a Phase 3 permission, separation of duties
where policy requires it, expected aggregate version, reason, evidence, explicit
transition, and audit event; it still cannot disable the unique index.

## 6. Dominican cédula normalization contract

The first normalization profile is identified by the immutable string
`do-cedula-v1`.

Neither the submitted value, canonical value, ciphertext, nor fingerprint is a
global primary key, public ID, routing key, URL component, analytics dimension,
or cross-module identifier. UUIDv7 account/identity/document IDs carry those
technical relationships under access control.

The algorithm is exact:

1. Accept a string of at most 64 Unicode scalar values. Reject null, arrays,
   numbers, invalid Unicode, and longer input before further work.
2. Reject all Unicode control characters except ASCII horizontal tab, carriage
   return, and line feed, which count as removable ASCII whitespace.
3. Remove only U+0020 SPACE, U+0009 TAB, U+000D CR, U+000A LF, and U+002D
   HYPHEN-MINUS, wherever they occur.
4. Do not apply Unicode normalization, case folding, numeric conversion, or
   locale-sensitive transformation.
5. Require exactly 11 remaining ASCII characters matching `[0-9]{11}`.
6. Preserve leading zeroes. The resulting 11-byte ASCII string is the canonical
   value supplied to encryption and HMAC.

Formatting normalization is distinct from structural/checksum validation and
from legal identity verification. Phase 1 must expose separate result types for
these concerns. A checksum rule cannot be enabled until an authoritative source,
version, expected test corpus, and false-rejection policy are recorded. Passing
format or checksum rules must never be reported as proof that a document exists
or belongs to the presenter.

### 6.1 Required normalization vectors

All successful outputs use the synthetic canonical value `00112345678`.

| Input                                            | Result        | Code                    |
| ------------------------------------------------ | ------------- | ----------------------- |
| `00112345678`                                    | `00112345678` | `OK`                    |
| `001-1234567-8`                                  | `00112345678` | `OK`                    |
| `001-1234567-8`                                  | `00112345678` | `OK`                    |
| `001 - 1234567 - 8`                              | `00112345678` | `OK`                    |
| `001\t1234567\r\n8`                              | `00112345678` | `OK`                    |
| `001‐1234567‐8` using U+2010                     | none          | `UNSUPPORTED_CHARACTER` |
| `００１１２３４５６７８` using full-width digits | none          | `NON_ASCII_DIGIT`       |
| `001.1234567.8`                                  | none          | `UNSUPPORTED_CHARACTER` |
| `0011234567`                                     | none          | `INVALID_LENGTH`        |
| `001123456789`                                   | none          | `INVALID_LENGTH`        |
| empty/whitespace only                            | none          | `INVALID_LENGTH`        |
| more than 64 Unicode scalar values               | none          | `INPUT_TOO_LONG`        |

These values may exist only in synthetic fixtures and documentation. Runtime
failures log the normalization profile and safe error code, never input,
canonical output, fingerprint, or ciphertext.

## 7. Document fingerprint contract

Plain SHA-256, unsalted hashes, database-resident salts, and general password
hash functions are prohibited for document equality. National identifiers have
too little entropy to resist an offline dictionary attack after a database dump.

Phase 1 uses HMAC-SHA-256 with a uniformly random 256-bit secret held outside
PostgreSQL. The input is UTF-8 bytes for these six fields joined by a single NUL
byte (`00`):

```text
trayvi.identity-document-fingerprint
normalization_profile
ISO-3166-1-alpha-2-country
issuer_code
document_type
canonical_document_value
```

For v1, country, issuer, and type are the canonical uppercase codes `DO`, `JCE`,
and `NATIONAL_ID`. The domain label is exact and immutable. A fingerprint row
stores the 32 raw bytes (`bytea`), `hmac-sha-256`, HMAC key version, and
normalization profile. Text/hex encodings are permitted in isolated test output
only.

### 7.1 Reproducible HMAC test vector

This key is synthetic and forbidden outside tests:

```text
key hex:
000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f

input fields:
trayvi.identity-document-fingerprint
do-cedula-v1
DO
JCE
NATIONAL_ID
00112345678

joined input UTF-8 hex:
7472617976692e6964656e746974792d646f63756d656e742d66696e6765727072696e7400646f2d636564756c612d763100444f004a4345004e4154494f4e414c5f4944003030313132333435363738

expected HMAC-SHA-256 hex:
297d981c7626bf7d24a9372b0bf8bea65631f1db0a5e4622f932e0e77b61091f
```

Tests must also prove that changing any scope field, normalization version,
value, key, separator, or byte encoding changes the result.

## 8. Authenticated envelope encryption and key custody

The canonical document value is retained only because trusted verification,
controlled correction, and HMAC/normalization-key rotation may require recovery.
If those purposes disappear, the default is crypto-erasure rather than indefinite
retention.

Each document uses authenticated envelope encryption:

1. Generate a random 256-bit data-encryption key (DEK) and a random 96-bit nonce.
2. Encrypt the canonical UTF-8 bytes using AES-256-GCM or an explicitly reviewed
   managed equivalent.
3. Bind immutable context as additional authenticated data (AAD): encryption
   schema version, document ID, identity ID, country, issuer, document type, and
   normalization profile.
4. Wrap the DEK with a non-exportable key-encryption key (KEK) in the approved
   KMS/HSM boundary.
5. Store ciphertext, nonce, authentication tag, wrapped DEK, algorithm/schema,
   and KEK identifier/version. Store neither plaintext DEK nor plaintext
   document.

The HMAC keyring and encryption KEK are separate keys, permissions, purposes,
and rotation procedures. Database readers cannot call decrypt or HMAC
operations. The application receives narrow workload-identity grants; production
human access is denied by default and governed break-glass access belongs to
Phase 3.

The idempotency request commitment for an identity-bearing request must also be
keyed and domain separated; an unkeyed digest of a low-entropy document would
create another offline guessing oracle. It uses a third, purpose-specific
idempotency-integrity key or a construction approved in ADR-012. It is never the
document uniqueness fingerprint and follows the short idempotency retention
window.

An authentication failure, missing key version, KMS denial, or incomplete
envelope fails closed before state mutation. Errors expose only a correlation ID
and safe code.

### 8.1 Reproducible AES-256-GCM test vector

The following deterministic material is synthetic and forbidden in production:

```text
DEK hex:
202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f

nonce hex:
000102030405060708090a0b

plaintext UTF-8:
00112345678

AAD UTF-8:
trayvi.identity-document-envelope|v1|document=018f0000-0000-7000-8000-000000000001|identity=018f0000-0000-7000-8000-000000000002|country=DO|issuer=JCE|type=NATIONAL_ID|normalization=do-cedula-v1

expected ciphertext hex:
6c626c967806dfd98acef1

expected authentication tag hex:
9a778f58998539b82075c2fe99329536
```

Tests must decrypt successfully and must fail for a changed ciphertext, tag,
nonce, AAD field, or key.

### 8.2 Rotation protocols

HMAC versions have `PRIMARY`, `LOOKUP_ACTIVE`, and `RETIRED` states in external
configuration, not in a secret database table.

1. Provision the new HMAC key with least privilege as `LOOKUP_ACTIVE`.
2. For every blocking document, decrypt inside the Identity boundary and insert
   its new-version fingerprint claim. Backfill is resumable, ordered, audited,
   rate-limited, and conflict detecting.
3. Verify source/target counts, uniqueness, failures, and a sampled independent
   recomputation. Any collision or unreadable envelope stops promotion.
4. During the transition, every lookup and new write computes aliases for all
   lookup-active versions in deterministic version order. A missing version
   fails closed.
5. Promote the new version to `PRIMARY` only after complete backfill and all
   readers/writers support it.
6. Retire old lookup aliases only after the approved retention and compromise
   procedure permits it.

KEK rotation normally rewraps each DEK without decrypting and rewriting the
document ciphertext. It records old/new KEK versions and verifies unwrap/decrypt
before removing old access. Content-key re-encryption is a different, explicitly
authorized procedure.

Changing the normalization profile uses the same dual-alias discipline. An
incompatible normalization cannot become write-primary until every blocking
claim can be converted safely or the identity is recollected through an approved
flow.

## 9. Database invariants and concurrency protocol

### 9.1 Required constraints

- Primary keys are UUIDv7 and foreign keys use explicit `RESTRICT`, `CASCADE`, or
  `SET NULL` semantics reviewed per relationship; protected identity history is
  never cascade-deleted accidentally.
- `person_identities.account_id` is `NOT NULL UNIQUE`.
- A constraint trigger, deferred to transaction end, rejects `accounts.status =
'ACTIVE'` unless exactly one linked identity is `ESTABLISHED` and at least one
  current document has a `BOUND` claim.
- A partial unique index covers blocking claims (`RESERVED`, `BOUND`,
  `TOMBSTONED`) on `(country_code, issuer_code, document_type,
normalization_profile, hmac_key_version, fingerprint)`.
- Envelope fields are protected by an all-or-none `CHECK`; fingerprint is exactly
  32 bytes; country/type/version fields are constrained and non-empty.
- Transition rows are append-only. Guard functions accept the expected aggregate
  version so stale decisions cannot overwrite a newer state.
- Verification and review state combinations have explicit `CHECK`/trigger
  guards. Terminal case results cannot be mutated.
- Restricted columns receive no `SELECT` grant for transport, reporting,
  observability, or support roles.

Every accepted HMAC key version has one alias per blocking document. Although key
version participates in the unique index, dual aliases make an existing document
collide under at least one common active version during rotation.

### 9.2 Atomic account creation

`check-then-insert` is prohibited. The required flow is:

1. `StartAccountCreation` creates or returns an opaque, expiring enrollment
   operation using repository idempotency. It creates no account.
2. `SubmitIdentityInformation` validates shape, normalizes, obtains the complete
   active key set, computes all HMAC aliases, and prepares an encrypted envelope
   before opening the mutation transaction.
3. The transaction locks the enrollment operation, verifies request-hash reuse,
   inserts a `PENDING_IDENTITY` account, its `PENDING` identity, document,
   `RESERVED` aliases in deterministic key-version order, transition records,
   idempotency result, and safe outbox message.
4. The partial unique index selects exactly one winner when different enrollment
   operations race for the same document. A losing transaction rolls back in
   full: no orphan account, identity, document, transition, or outbox row remains.
5. After rollback, a separate safe update records only a generic conflict outcome
   on the already existing enrollment operation. It does not link the caller to
   the existing account or reveal its existence.
6. Repeated requests with the same idempotency key and request hash return the
   stored result. The same key with a different request hash returns a generic
   idempotency conflict and performs no mutation.
7. A trusted verification outcome binds claims, establishes the identity, and
   activates the account in one later transaction. It is idempotent by external
   evidence/decision ID.

Serializable isolation is not required if the implemented constraints and row
locks prove these invariants. If integration tests reveal predicate races outside
the unique index, the affected transaction must use an explicit advisory lock or
`SERIALIZABLE` with bounded retry; no process-local lock is acceptable.

### 9.3 Duplicate-safe outcome

The public response for both a newly reserved document and an already blocking
document is the same accepted envelope (normally HTTP 202 at the later transport
layer): an opaque enrollment-operation ID, generic next-step state, correlation
ID, and no account or identity ID. Timing and response-size tests must prevent an
obvious duplicate oracle.

An internal conflict code can distinguish `CLAIM_ALREADY_BLOCKING`,
`CLAIM_RACE_LOST`, `IDEMPOTENT_REPLAY`, `KEY_VERSION_UNAVAILABLE`, and
`ENVELOPE_FAILURE`. Internal evidence may include claim/key versions and database
constraint identity, but never document value, fingerprint bytes, ciphertext,
wrapped key, or another person's IDs.

The response directs all callers through the same future recovery/review entry
point. That entry point is only a contract seam in Phase 1; authentication and
recovery proof belong to Phase 2. Support cannot bypass it or disclose whether a
document is registered.

Internal classification happens only after trusted evidence is available; it
never changes the unauthenticated response:

| Situation                         | Internal treatment                                                                                 | Public treatment           |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| Legitimate existing person        | create an opaque recovery candidate referencing the original relationship only after Phase 2 proof | generic accepted next step |
| Account-takeover attempt          | retain safe attempt evidence, rate-limit/escalate by policy, reveal no relationship                | generic accepted next step |
| Accidental duplicate registration | close/expire the new enrollment operation without creating another aggregate                       | generic accepted next step |
| Recovery candidate                | hand only the opaque operation/reference to the future Phase 2 recovery boundary                   | generic accepted next step |
| Manual-review candidate           | queue an evidence-backed case for a future authorized reviewer; uniqueness stays enforced          | generic accepted next step |

## 10. Conceptual operation and error contracts

These are use-case contracts, not final URLs or an authorization to add endpoints.

| Operation                          | Caller class                                   | Input                                                                    | Success                                             | Safe failures                                                     |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| `StartAccountCreation`             | unauthenticated enrollment client              | idempotency key and minimal locale/channel metadata                      | opaque expiring operation and generic next step     | invalid request, rate limited, unavailable                        |
| `SubmitIdentityInformation`        | holder of enrollment capability                | operation ID, country, issuer, type, document input, idempotency key     | generic accepted outcome                            | invalid format; request cannot be completed; idempotency conflict |
| `ResolveIdentityConflictSafely`    | future proven principal or authorized reviewer | opaque conflict/recovery reference and evidence, never a document lookup | generic accepted recovery/review state              | request cannot be completed; unauthorized; stale state            |
| `RecordTrustedVerificationOutcome` | trusted internal adapter                       | decision ID, case ID, outcome, policy version, evidence refs             | idempotent resulting state                          | stale/invalid transition; missing evidence; unavailable key       |
| `GetOwnAccountState`               | future authenticated principal                 | own account context                                                      | safe account/identity state and allowed next action | not authorized; not found using anti-enumeration policy           |
| `RequestAccountClosure`            | future authenticated principal                 | reason category and idempotency key                                      | accepted closure request                            | legal/policy hold without exposing restricted rationale           |
| `ApplyAccountRestriction`          | future Phase 3 authorized actor                | account ID, expected version, reason, evidence                           | new state and transition ID                         | stale state; unauthorized; missing evidence                       |

Transport errors must use the established Problem Details schema, a stable safe
code, correlation ID, and field errors only for non-sensitive shape/format
problems. Candidate public codes are:

```text
ACCOUNT_CREATION_ACCEPTED
IDENTITY_SUBMISSION_ACCEPTED
INVALID_IDENTITY_DOCUMENT_FORMAT
IDEMPOTENCY_CONFLICT
REQUEST_CANNOT_BE_COMPLETED
RATE_LIMITED
```

No error title, detail, header, redirect, status variation, or field path may say
that a person, document, account, or verification record exists. The final
transport mapping and endpoint paths require implementation review.

## 11. Privacy, retention, deletion, and access

### 11.1 Data classification

| Data                                        | Field kind                                                                             | Class                                     | Purpose                                        | Permitted readers                                  | Retention/deletion baseline                                                     | Forbidden propagation                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Raw submitted/canonical document in memory  | direct identifier                                                                      | Restricted                                | normalize, encrypt, fingerprint                | Identity use case only                             | zeroize/drop references promptly after transaction; never persist plaintext     | all logs, traces, metrics, events, analytics, URLs, tokens |
| Ciphertext                                  | protected identifier                                                                   | Restricted                                | verification, correction, controlled rotation  | Identity repository and crypto workload only       | active purpose plus approved post-closure window; then crypto-erase unless hold | general query/reporting/support roles and events           |
| HMAC fingerprint                            | protected identifier                                                                   | Restricted security derivative            | equality and uniqueness                        | Identity repository/key-rotation job only          | blocking/tombstone period approved by legal/security                            | API responses, telemetry, analytics, outbox                |
| Nonce, tag, wrapped DEK, key versions       | security-sensitive metadata                                                            | Restricted                                | authenticated decryption and rotation          | Identity crypto workload only                      | aligned to encrypted envelope or shorter after erasure                          | general query/reporting/support, telemetry, events         |
| Document country/issuer/type/profile        | operational metadata when unlinked; protected context when linked                      | Confidential when linked                  | scope cryptographic claim                      | Identity use case and approved operations          | aligned to identity record                                                      | public events or profiles                                  |
| Verification evidence reference/attestation | direct/protected identifier or security-sensitive metadata, according to evidence type | Restricted                                | justify establishment/review                   | verification/reviewer workloads with purpose grant | provider/legal policy; delete or detach on expiry                               | general support, events, analytics                         |
| Account/identity UUIDv7                     | public identifier, exposure scoped                                                     | Confidential when linked to a person      | internal relationship and authorized self-link | owning modules and authorized future roles         | relationship lifecycle plus approved audit window                               | unauthenticated responses and cross-person disclosure      |
| States, safe reason/policy codes            | operational metadata                                                                   | Confidential                              | enforce lifecycle and explain own state        | owning modules; authorized self-service/review     | lifecycle plus approved audit window                                            | public analytics at row level                              |
| Actor/evidence refs in transitions          | security-sensitive metadata                                                            | Restricted or Confidential by actor class | accountability                                 | governed review/audit workloads                    | approved audit/legal window                                                     | public event payloads                                      |
| Idempotency key/commitment                  | security-sensitive metadata                                                            | Restricted                                | retry safety                                   | idempotency component only                         | shortest bounded replay window                                                  | logs and downstream events                                 |
| Aggregate safe event ID/type/time           | operational metadata                                                                   | Internal                                  | reliable module integration                    | declared consumers                                 | event retention policy                                                          | protected source fields                                    |

Before implementation, every schema column must carry an inventory entry with
classification, purpose, owner, readers, writers, event/telemetry policy,
retention trigger, deletion action, and legal-hold behavior.

### 11.2 Retention and deletion rules

- Production durations are not guessed in code. Product/privacy/legal must
  approve the collection purpose, lawful basis, age/jurisdiction constraints,
  active and post-closure durations, evidence-provider deletion, legal holds,
  backup expiry, and data-subject workflows before real data collection.
- Closing an account revokes use but does not silently free a document for a new
  account. The default is a keyed tombstone whose permitted duration requires
  approval. Recovery/reactivation must target the original relationship.
- When deletion is permitted, destroy the wrapped DEK or revoke its unique key
  material, clear ciphertext/envelope metadata as allowed, and retain only the
  minimum approved tombstone and transition proof. Backup copies expire through
  documented backup retention; they are not selectively rewritten.
- An abandoned, never-established reservation may be released only after a
  rate-limited expiry/review policy prevents malicious identifier lockout.
- Database export, debugging, support tooling, and test fixtures use synthetic or
  irreversibly transformed data. Production snapshots are prohibited in lower
  environments.

Production enablement is blocked until these governance decisions are approved.
They do not block implementing and testing the architecture with synthetic data.

## 12. Threat model

| Threat                        | Asset/attacker                                     | Attack                                                 | Required controls                                                                                                 | Residual risk and proof                                                                               |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Duplicate accounts            | account integrity; ordinary or malicious applicant | same cédula submitted twice                            | HMAC claim plus partial unique index and atomic transaction                                                       | different genuine documents may represent one person; prove same-document single winner in PostgreSQL |
| Concurrency race              | uniqueness; parallel clients/workers               | simultaneous first registration                        | database uniqueness, deterministic aliases, rollback, no process lock                                             | database/KMS outage; run 50-way races for 10 rounds                                                   |
| Identity theft                | person/account; holder of stolen number            | registers another person's document                    | document format is not verification; pending state; later trusted proof and governed review                       | provider and proof strength deferred; no activation without accepted outcome                          |
| Enumeration                   | privacy; remote caller/support user                | varies identifiers and observes response/status/timing | same accepted response, generic recovery seam, rate limits, padded/bounded behavior, no support lookup disclosure | network timing noise; statistical timing/size test                                                    |
| Offline fingerprint guessing  | document value; database thief                     | brute-forces low-entropy identifiers                   | external 256-bit HMAC key, domain separation, no plaintext                                                        | DB+HMAC-key compromise; rotation/incident playbook tested                                             |
| Database dump                 | all persisted identity material; intruder/insider  | copies tables/backups                                  | envelope encryption, separate KMS/HMAC keys, least privilege, encrypted backups                                   | metadata and status exposure; minimize fields and audit exports                                       |
| Log/trace leakage             | identifier; developer/operator                     | error or debug captures input/derived values           | typed redaction, allowlisted structured fields, secret scanner, failure-path tests                                | third-party agent capture; production sink review required                                            |
| Event/analytics leakage       | identifier; internal consumers                     | restricted fields placed in outbox/event               | safe event schemas and contract tests; opaque IDs only when needed                                                | consumer joins can re-identify; purpose/access review                                                 |
| HMAC key compromise           | uniqueness privacy; intruder                       | computes document dictionary or false aliases          | isolated keyring, usage-only grants, versioning, rapid dual-key backfill, alerts                                  | historic guesses possible while compromised; incident/legal response required                         |
| KEK/workload compromise       | plaintext; intruder                                | unwraps DEKs or calls decrypt in bulk                  | non-exportable KEK, narrow workload identity, quotas, audited calls, rewrap/revoke                                | live service compromise can decrypt authorized rows; detection and containment tests                  |
| Ciphertext substitution       | identity binding; DB writer                        | swaps encrypted values across rows                     | AES-GCM AAD binds document/identity/scope/version; immutable IDs                                                  | authorized app could create valid bad envelope; domain tests and change control                       |
| Malicious retries             | resource/uniqueness; bot                           | floods unique/reused operations                        | idempotency, bounded operation expiry, rate limits, quotas, safe replay                                           | distributed bots; operational controls finalized before production                                    |
| Reservation denial of service | real person's access; attacker                     | reserves a victim's number and never verifies          | bounded pending state, no activation, governed recovery/review, release policy                                    | balance between lockout and duplicate prevention needs product/security decision                      |
| Support bypass                | identity/account; support actor                    | discloses existence or edits state directly            | no direct table access, guarded commands, Phase 3 permission/audit integration                                    | Phase 3 not yet present; support mutation remains disabled before then                                |
| Insider access                | all identity data; privileged employee             | queries/decrypts without purpose                       | separate roles, deny-by-default KMS, purpose-bound job, audit hooks, break glass later                            | database/KMS administrators; governance and monitoring required pre-production                        |
| Account-takeover preparation  | future credentials/recovery; attacker              | uses identity endpoint as a recovery oracle            | Phase 1 creates no login/recovery proof; generic response; opaque operations                                      | complete mitigation depends on Phase 2 authentication/recovery ADR                                    |
| Human-review abuse            | person/state; reviewer                             | silently overrides failed proof                        | explicit state machine, reason/evidence, immutable transition, no direct SQL                                      | strong reviewer authorization/audit depends on Phase 3                                                |

No Critical or High residual risk may be accepted silently. A risk needing Phase
2, Phase 3, or governance remains an explicit production blocker at the boundary
where that control is required.

## 13. Migration plan

No migration is created by this plan. A separately authorized implementation
starts after existing immutable migrations `0001` through `0004` and proposes:

| Order  | Conceptual migration              | Contents                                                                                                             | Rollback rule                                                          |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `0005` | account and identity core         | schemas/ownership if needed, accounts, identities, enrollment operations, status histories, base constraints/indexes | down allowed only on an empty/fresh environment; otherwise fail safely |
| `0006` | protected documents and claims    | document envelopes, fingerprint aliases, unique blocking index, checks, restricted grants                            | refuse destructive down when domain rows exist                         |
| `0007` | verification and lifecycle guards | cases, evidence, reviews, deferred activation guard, transition guards, safe outbox integration/grants               | reverse objects in dependency order on empty/fresh environment only    |

Final numbering/names depend on repository state at authorization time. Migration
files are immutable after acceptance and include paired down behavior compatible
with the existing runner. Use expand/backfill/verify/contract for later changes;
never edit an applied migration to rotate a key or normalization profile.

Implementation evidence must show:

1. clean database `up -> verify -> down -> up -> verify`;
2. repeat execution/status behavior;
3. intended indexes, constraints, triggers, owners, and grants from catalog
   queries;
4. application runtime role cannot perform DDL or select restricted columns;
5. seeded concurrent transactions yield one winner and no orphans;
6. rollback refuses to erase populated identity data.

## 14. Test and evidence strategy

### 14.1 Unit and property tests

- Every normalization vector above, length boundary, Unicode control category,
  Unicode digit/dash confusable, preservation of leading zero, and idempotence
  (`normalize(normalize(x)) = normalize(x)`).
- HMAC vector and field/key/version/domain-separation mutations.
- AES-GCM vector, successful round trip, randomized production-adapter nonce, and
  tampering of ciphertext/tag/nonce/AAD/key.
- Legal state-transition matrices for account, identity, case, review, document,
  and claim; every illegal edge rejected.
- Request hash/idempotency replay and mismatch behavior.
- Error and telemetry serializers reject restricted values by construction.
- Outbox event contract contains only allowlisted safe fields.
- Rotation state machine, partial/resumed backfill, missing key, collision,
  promote, retire, and rollback behavior.

### 14.2 Real PostgreSQL integration and concurrency tests

- Apply migrations on the same supported PostgreSQL/PostGIS runtime as Phase 0.
- Verify database constraints independently of repositories by attempting invalid
  direct writes with a migration-owner test connection.
- Run at least 50 simultaneous, independently connected submissions of the same
  synthetic cédula for 10 rounds. Every round must produce exactly one account,
  one identity, one current document, one alias per active key version, one
  eventual active account after one trusted outcome, 49 generic conflicts, and
  zero orphan transitions/outbox rows.
- Run simultaneous submissions using different idempotency keys and same-key
  replays; prove stored responses and request-hash mismatch behavior.
- Pause/fail at each mutation boundary and KMS/fingerprint call to prove atomic
  rollback and safe retry.
- Rotate between two synthetic HMAC versions while submissions continue; prove
  no duplicate bypass and complete aliases.
- Exercise deferred activation and transition triggers under stale versions.
- Verify grants with runtime, migration, worker, and deliberately unauthorized
  roles.

### 14.3 Security, privacy, and operational evidence

- Automated repository, log-capture, event-contract, Problem Details, and tracing
  scans contain none of the synthetic raw document, expected fingerprint,
  ciphertext, wrapped key, or idempotency secret outside approved fixtures.
- Statistical comparison of duplicate/new public responses checks status, schema,
  length, redirects, headers, and bounded timing. This is evidence against an
  obvious oracle, not a claim of perfect timing indistinguishability.
- Key access, rotation, rewrap, compromise, crypto-erasure, and failed-decrypt
  drills produce safe audit metadata and no plaintext.
- A column-level data inventory and migration privilege report is attached to the
  implementation evidence.
- `pnpm verify:full` passes from a fresh checkout with the required PostgreSQL
  service and no regression to Phase 0 gates.

Evidence must be machine-readable where practical, contain synthetic data only,
and live under `docs/phases/phase-01-accounts-identity/evidence/` in the later
implementation/audit commits.

## 15. ADRs required before implementation completion

### ADR-011 — Account/person identity model

Must decide and record:

- account versus person-identity ownership and one-to-one cardinality;
- one base account with multiple future role attachments;
- enrollment ordering and the atomic cross-module unit of work;
- account/identity/verification/review lifecycles and transition evidence;
- closure, reactivation prohibition, duplicate-safe outcome, and support limits;
- database activation and concurrency invariants.

### ADR-012 — National identity protection and key rotation

Must decide and record:

- exact `do-cedula-v1` normalization and versioning;
- domain-separated HMAC-SHA-256 equality fingerprint and external key custody;
- AES-256-GCM envelope, AAD, separate KEK/HMAC purposes, and failure behavior;
- alias uniqueness, HMAC rotation/backfill, KEK rewrap, normalization migration,
  tombstones, and crypto-erasure;
- database fields/access controls and reproducible crypto vectors.

Duplicate-recovery behavior and reservation/tombstone expiry belong in these ADRs
unless review discovers an independently reversible decision. New ADR numbers
must be allocated through `docs/adr/README.md`; this plan does not invent one.

## 16. Open decisions

### 16.1 Engineering

No engineering decision blocks implementation authorization. The byte contracts,
invariants, lifecycles, transaction boundary, and ownership are defined;
ADR-011/012 must ratify them during implementation. Implementers may refine:

- final internal class/table/index names and whether transition guards use one or
  multiple SQL functions;
- repository query shape and transaction library, provided one connection and
  one PostgreSQL transaction span aggregate creation;
- safe internal event names and future consumers;
- bounded batch-size defaults for synthetic rotation tests and later production
  backfills.

Any proposed change to a cryptographic byte contract, uniqueness or activation
invariant, lifecycle, or module owner is not a refinement and requires ADR review.
Production KMS/HSM, workload identity, key custodians, monitoring, break-glass,
rotation, and compromise SLOs remain undecided; the safe default is no production
key or decryption access. This blocks production, not synthetic implementation.

Phase 2 must decide authentication/recovery proof and anti-ATO behavior; Phase 3
must decide reviewer/support permissions, separation of duties, complete audit,
and emergency access. Until then there is no login/recovery implementation and
human state-changing operations remain disabled.

### 16.2 Product

- Decide pending-reservation expiry, malicious lockout recovery, correction,
  disputed-identity handling, and reviewer policy with Trust/Safety. Until then,
  no claim is released and no support override exists.
- Decide whether and when a closed account can undergo a governed reactivation.
  Until then, `CLOSED` is terminal and no replacement account is created.
- Decide which future customer, driver, merchant/business, and operator
  capabilities attach to the base account. No role is implemented in Phase 1.

These decisions block the affected production journey or later phase, not a
synthetic Phase 1 implementation.

### 16.3 Legal/regulatory

- Approve lawful basis, notice/consent where applicable, minimum age and
  jurisdiction constraints, active/post-closure/tombstone retention, legal holds,
  data-subject workflows, evidence deletion, and backup expiry.
- Identify an authoritative cédula checksum/structural-validation source and
  approve false-rejection handling before any such rule is called valid.

The safe default is to collect no real identity data, perform format validation
only, and never label a document verified. These decisions block production, not
synthetic implementation.

### 16.4 Provider

- Select verification methods/provider, assurance levels, evidence
  minimization/retention, webhook authenticity, availability behavior, and an
  opaque evidence-storage boundary.
- Select the production KMS/HSM only together with the Engineering/Security
  custody decision. Phase 1 must keep provider-neutral ports.

The safe default is metadata/reference-only evidence, no weak local blob store,
no provider adapter, and accounts remaining `PENDING_IDENTITY`. These decisions
block production activation, not synthetic implementation.

## 17. Acceptance criteria

Every criterion is blocking for Phase 1 implementation closure unless its
blocking column explicitly says production only. Evidence is required; prose
assertion alone is insufficient.

| ID        | Verifiable criterion                                                                                                                                         | Required evidence                                   | Blocking        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------- |
| P1-AC-001 | Implementation changes only Accounts/Identity foundations and approved composition/migration/test/docs seams; no Phase 2+ feature is implemented.            | changed-file manifest and architecture report       | Phase 1 closure |
| P1-AC-002 | Accounts and Identity use domain/application/infrastructure dependency direction with no cross-infrastructure import.                                        | boundary tests and dependency graph                 | Phase 1 closure |
| P1-AC-003 | Account, person identity, document, fingerprint claim, verification case/evidence, review, and enrollment operation are distinct owned concepts.             | ADR-011/012 plus schema/domain tests                | Phase 1 closure |
| P1-AC-004 | All exposed entity IDs are UUIDv7 and opaque.                                                                                                                | unit/integration format and ordering tests          | Phase 1 closure |
| P1-AC-005 | One base account can accept multiple future role attachments without identity/account duplication; roles themselves are not implemented.                     | ADR-011 and compile-time boundary fixture           | Phase 1 closure |
| P1-AC-006 | Account lifecycle implements only the legal transitions and terminal `CLOSED` behavior in this plan.                                                         | exhaustive transition matrix tests                  | Phase 1 closure |
| P1-AC-007 | Identity, verification case, review, document, and claim lifecycles are separate and reject invalid combinations.                                            | exhaustive unit plus direct-DB rejection tests      | Phase 1 closure |
| P1-AC-008 | Every material transition records actor class/ref, reason, evidence/policy ref, old/new state, version, and time atomically.                                 | integration rows and outbox evidence                | Phase 1 closure |
| P1-AC-009 | A closed/retired relationship is not silently reopened and its blocking claim is not silently released.                                                      | lifecycle and negative SQL tests                    | Phase 1 closure |
| P1-AC-010 | `do-cedula-v1` follows the exact byte/character contract and every listed vector.                                                                            | unit/property test report                           | Phase 1 closure |
| P1-AC-011 | Formatting, optional structural/checksum assessment, and trusted verification are distinct result types; formatting cannot activate an account.              | type/API tests and activation negative test         | Phase 1 closure |
| P1-AC-012 | Fingerprints use the exact domain-separated HMAC-SHA-256 byte contract and reproduce the expected vector.                                                    | crypto unit test artifact                           | Phase 1 closure |
| P1-AC-013 | Changing any HMAC scope field, key/version, value, separator, or encoding changes the fingerprint.                                                           | mutation test table                                 | Phase 1 closure |
| P1-AC-014 | No plain SHA-256, unsalted digest, document plaintext, or HMAC key is stored or used as the uniqueness mechanism.                                            | code/schema scan and review                         | Phase 1 closure |
| P1-AC-015 | AES-256-GCM envelope/AAD reproduces the vector, decrypts valid data, and rejects all specified tampering.                                                    | crypto unit test artifact                           | Phase 1 closure |
| P1-AC-016 | Encryption KEK, per-record DEK, document HMAC key, and idempotency-integrity key have separate purposes; plaintext keys/documents do not persist.            | adapter tests, schema/secret inventory              | Phase 1 closure |
| P1-AC-017 | HMAC dual-alias rotation/backfill and KEK rewrap are resumable, fail closed, and prove completeness before promotion/retirement.                             | two-version integration/drill report                | Phase 1 closure |
| P1-AC-018 | Raw/normalized documents and protected derivatives are absent from logs, traces, metrics, errors, URLs, tokens, analytics, and safe events.                  | canary capture plus automated scans                 | Phase 1 closure |
| P1-AC-019 | New immutable migrations follow existing migrations, have reviewed down behavior, and pass clean/repeat/down/up verification.                                | migration transcript and checksums                  | Phase 1 closure |
| P1-AC-020 | PostgreSQL enforces one identity per account and rejects activation without exactly one established identity and a bound claim.                              | catalog evidence and direct SQL negative tests      | Phase 1 closure |
| P1-AC-021 | A partial unique database index protects every blocking fingerprint alias across the complete scope.                                                         | index definition and collision tests                | Phase 1 closure |
| P1-AC-022 | Account, identity, document, aliases, transitions, idempotency result, and outbox commit atomically or leave no orphan.                                      | injected-failure integration matrix                 | Phase 1 closure |
| P1-AC-023 | In each of 10 real-PostgreSQL rounds, 50 concurrent same-document attempts yield exactly one aggregate winner and 49 generic conflicts.                      | machine-readable concurrency results and row counts | Phase 1 closure |
| P1-AC-024 | Same-key/same-request retries replay one stored result; identity request commitments are keyed/domain-separated; mismatched reuse mutates nothing.           | unit/integration replay and offline-oracle matrix   | Phase 1 closure |
| P1-AC-025 | Runtime roles have no DDL/direct transition write or restricted-column read privileges beyond their narrow workload purpose.                                 | PostgreSQL grants report and denial tests           | Phase 1 closure |
| P1-AC-026 | New and duplicate submissions have the same public status/schema/size class/next step and reveal no existing entity ID.                                      | contract snapshots and oracle comparison            | Phase 1 closure |
| P1-AC-027 | Internal diagnostics distinguish operational causes without containing raw document, fingerprint, ciphertext, key material, or another person's identifiers. | structured log/evidence capture scan                | Phase 1 closure |
| P1-AC-028 | Conceptual operations map to established versioned Problem Details and stable safe codes without finalizing Phase 2 auth contracts.                          | API contract tests/review                           | Phase 1 closure |
| P1-AC-029 | Every persisted field has classification, purpose, owner, readers/writers, retention/deletion, legal-hold, event, and telemetry policy.                      | approved column inventory                           | Production only |
| P1-AC-030 | Closure/expiry/crypto-erasure/tombstone/backup behavior follows an approved retention and legal policy.                                                      | approval references and deletion drill              | Production only |
| P1-AC-031 | Threat-model controls have tests or an explicit later-phase/production blocker; no Critical/High risk is silently accepted.                                  | reviewed threat register and test mapping           | Phase 1 closure |
| P1-AC-032 | Normalization, crypto, lifecycle, idempotency, redaction, event, and rotation unit/property tests pass.                                                      | test report                                         | Phase 1 closure |
| P1-AC-033 | Real PostgreSQL proves constraints, grants, transaction rollback, concurrency, and rotation under supported runtime versions.                                | integration report                                  | Phase 1 closure |
| P1-AC-034 | ADR-011 and ADR-012 are accepted and the ADR register links them without rewriting prior ADR history.                                                        | ADR files/register diff                             | Phase 1 closure |
| P1-AC-035 | Fresh-checkout `pnpm verify:full` and all required CI gates pass with no Phase 0 regression.                                                                 | CI run ID, commit, gate summary                     | Phase 1 closure |
| P1-AC-036 | Implementation report, evidence manifest, final audit, changed-file scope, and no unresolved Critical/High finding establish a final PASS.                   | implementation/audit documents and evidence hashes  | Phase 1 closure |

## 18. Implementation sequence after separate authorization

1. Draft and accept ADR-011 and ADR-012; update the ADR register.
2. Add failing normalization, cryptographic, lifecycle, and boundary tests.
3. Add domain value objects and state machines without transport endpoints.
4. Add reviewed migrations and direct database invariant tests.
5. Add Identity crypto/keyring adapters using synthetic/local test providers and
   fail-closed configuration.
6. Add repositories and the single-transaction enrollment application service.
7. Add idempotency/outbox composition and safe conceptual transport mapping only
   if explicitly included in the implementation authorization.
8. Run concurrency, rotation, privilege, redaction, migration, and failure
   injection suites.
9. Produce implementation evidence and an independent Phase 1 final audit.

Each step must keep the repository buildable and must not introduce login,
sessions, recovery, permissions, provider integration, or future role behavior.

## 19. Definition of ready

The plan is ready because it fixes the important engineering decisions before
code: ownership, boundaries, state machines, normalization bytes, HMAC bytes,
envelope/AAD, key separation/rotation, schema constraints, concurrent ordering,
generic duplicate outcome, privacy treatment, tests, migrations, ADRs, and
evidence.

The remaining decisions have explicit safe defaults and owners. They block
production use or their later phase, not a synthetic Phase 1 implementation.

```text
PHASE 0 FINAL RE-AUDIT — PASS
PHASE 0 — CLOSED
AC-031 — DEFERRED — PRE-PRODUCTION GOVERNANCE

PHASE 1 — PLAN — COMPLETE
READY FOR PHASE 1 IMPLEMENTATION
SEPARATE HUMAN AUTHORIZATION REQUIRED BEFORE IMPLEMENTATION
```

No Phase 1 implementation begins under this document-only authorization.
