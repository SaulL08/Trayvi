# SPEC-001 — Contact verification and OTP challenges — Design

Status: Approved (early, see requirements §7)  
Requirements: [requirements.md](requirements.md)

## 1. Approach

A new business module, `modules/auth`, owns contact points, challenges, rate
limits, delivery, and callbacks. Each capability lives in its own subdirectory
inside each layer (`src/domain/contact/`, `src/application/contact/`,
`src/infrastructure/contact/`, and so on), so the architecture checker's layer
rule still applies and streams own disjoint paths.

PostgreSQL adapters take a `SqlExecutor` from the caller. Application services
receive a `TransactionRunner`, so the composition root decides transaction scope.
This lets SPEC-002 bind a contact inside the Phase 1 enrollment transaction.

The design relies on ADR-003 (SQL migrations), ADR-004 (UUIDv7), ADR-006
(configuration), ADR-007 (Problem Details), ADR-008 (outbox), ADR-009
(redaction), ADR-012 (dual-alias rotation pattern), and the pending ADR-013.

Sign-in and registration will need the plaintext number again to create the
contact envelope. The challenge does not keep it (PLAN §7.3). Instead, the caller
submits the number again with the contact proof. Consumption normalizes and
fingerprints it, and fails unless the fingerprint matches the proof.

## 2. Contracts frozen before streams start

The scaffold creates these files under `modules/auth/src/contracts/`. They are
integration-owned. Streams import them and never edit them.

### 2.1 Types and ports

```ts
// contracts/runtime.ts
export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  uuidV7(): string;
}
export interface RandomSource {
  bytes(length: number): Buffer;
}
export interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}
export interface TransactionRunner {
  inTransaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

// contracts/keys.ts
export type AuthKeyPurpose =
  | 'auth-contact-fingerprint'
  | 'auth-contact-kek'
  | 'auth-otp-commitment'
  | 'auth-subject-commitment';
export interface VersionedKey {
  readonly purpose: AuthKeyPurpose;
  readonly version: string; // ^[a-z0-9][a-z0-9._-]{0,63}$
  readonly state: 'PRIMARY' | 'LOOKUP_ACTIVE' | 'RETIRED';
  readonly material: Buffer; // 32 bytes; never logged or serialized
}
export interface AuthKeyring {
  /** Primary first, then lookup-active versions in ascending version order. Throws AuthKeyError if none. */
  active(purpose: AuthKeyPurpose): readonly VersionedKey[];
  primary(purpose: AuthKeyPurpose): VersionedKey;
}
export class AuthKeyError extends Error {
  readonly code: 'KEY_UNAVAILABLE' | 'KEY_PURPOSE_COLLISION' | 'KEY_INVALID';
}

// contracts/contact.ts
export type ContactChannel = 'PHONE';
export const PHONE_NORMALIZATION_PROFILE = 'e164-v1' as const;
export type PhoneNormalizationFailure =
  | 'INPUT_TOO_LONG'
  | 'INVALID_LENGTH'
  | 'NON_ASCII_DIGIT'
  | 'UNSUPPORTED_CHARACTER'
  | 'MISSING_CALLING_CODE'
  | 'UNSUPPORTED_REGION';
export interface CallingCodePolicy {
  readonly code: string; // ASCII digits, 1-3
  readonly nationalNumberLength: number;
  readonly destinationCodes?: readonly string[];
}
export interface PhoneNumberingPolicy {
  readonly defaultCallingCode?: string;
  readonly callingCodes: readonly CallingCodePolicy[];
}
export interface NormalizedPhone {
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly canonical: string; // never logged
}
export type PhoneNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedPhone }
  | { readonly ok: false; readonly code: PhoneNormalizationFailure };
export interface PhoneNormalizer {
  normalize(input: unknown): PhoneNormalizationResult;
}
export interface ContactFingerprint {
  readonly channel: ContactChannel;
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly keyVersion: string;
  readonly bytes: Buffer; // exactly 32
}
export interface ContactFingerprintSet {
  readonly primary: ContactFingerprint;
  readonly lookup: readonly ContactFingerprint[]; // includes primary
}
export interface ContactFingerprinter {
  fingerprint(value: NormalizedPhone): ContactFingerprintSet;
}
export type ContactPointState = 'ACTIVE' | 'REPLACED' | 'REVOKED';
export type ContactTransitionReason =
  'REGISTRATION' | 'RECOVERY' | 'CONTACT_CHANGE' | 'ACCOUNT_CLOSED';
export interface BindPrimaryContactCommand {
  readonly accountId: string;
  readonly phone: NormalizedPhone;
  readonly fingerprints: ContactFingerprintSet;
  readonly reason: 'REGISTRATION';
  readonly occurredAt: Date;
  readonly correlationId: string;
}
export interface ReplacePrimaryContactCommand {
  readonly accountId: string;
  readonly expectedContactId: string;
  readonly phone: NormalizedPhone;
  readonly fingerprints: ContactFingerprintSet;
  readonly reason: 'RECOVERY' | 'CONTACT_CHANGE';
  readonly caseId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}
export type ContactBindingResult =
  | { readonly kind: 'BOUND'; readonly contactId: string }
  | { readonly kind: 'CONTACT_ALREADY_BOUND' }
  | { readonly kind: 'STALE_CONTACT' };
/** Seals a phone that is not yet a contact point (SPEC-003 pending contact). */
export interface SealedPhone {
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer; // 12 bytes
  readonly tag: Buffer; // 16 bytes
  readonly wrappedKey: Buffer;
  readonly kekVersion: string;
}
export interface ContactEnvelopeSealer {
  /** AAD: trayvi.auth-pending-contact-envelope|v1|owner=<ownerId>|channel=PHONE|normalization=e164-v1 */
  seal(phone: NormalizedPhone, ownerId: string): Promise<SealedPhone>;
  /** Throws AuthKeyError or fails closed on any authentication failure. */
  open(sealed: SealedPhone, ownerId: string): Promise<NormalizedPhone>;
}
/** Implemented by ws-a. Every method runs inside the caller's transaction. */
export interface ContactPointCommands {
  bindPrimary(sql: SqlExecutor, command: BindPrimaryContactCommand): Promise<ContactBindingResult>;
  replacePrimary(
    sql: SqlExecutor,
    command: ReplacePrimaryContactCommand,
  ): Promise<ContactBindingResult>;
  findAccountByFingerprints(
    sql: SqlExecutor,
    fingerprints: ContactFingerprintSet,
  ): Promise<{ readonly accountId: string; readonly contactId: string } | undefined>;
  activePrimary(
    sql: SqlExecutor,
    accountId: string,
  ): Promise<{ readonly contactId: string; readonly phone: NormalizedPhone } | undefined>;
}

// contracts/challenge.ts
export type ChallengePurpose =
  'CONTACT_PROOF' | 'STEP_UP' | 'RECOVERY_NEW_CONTACT' | 'RECOVERY_CANCEL' | 'CONTACT_CHANGE_NEW';
export type ChallengeState =
  'PENDING' | 'VERIFIED' | 'CONSUMED' | 'EXPIRED' | 'EXHAUSTED' | 'CANCELLED';
export interface ChallengePolicy {
  readonly codeLifetimeSeconds: number; // 120..600
  readonly maxFailedAttempts: number; // 3..10
  readonly maxResends: number; // 0..5
  readonly resendCooldownSeconds: number; // 15..120
  readonly proofLifetimeSeconds: number; // 120..900
}
export interface ClientContext {
  readonly installationCommitment: Buffer; // 32 bytes, from SubjectCommitter
  readonly networkCommitment: Buffer; // 32 bytes, from SubjectCommitter
  readonly correlationId: string;
  readonly locale: string; // BCP 47, e.g. es-DO
}
export interface StartChallengeCommand {
  readonly purpose: ChallengePurpose;
  readonly phoneInput: unknown;
  readonly client: ClientContext;
}
export type StartChallengeResult =
  | {
      readonly kind: 'ACCEPTED';
      readonly challengeId: string;
      readonly expiresAt: Date;
      readonly resendAvailableAt: Date;
    }
  | { readonly kind: 'INVALID_CONTACT_FORMAT'; readonly code: PhoneNormalizationFailure }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };
export interface ResendChallengeCommand {
  readonly challengeId: string;
  readonly phoneInput: unknown;
  readonly client: ClientContext;
}
export type ResendChallengeResult =
  | { readonly kind: 'ACCEPTED'; readonly resendAvailableAt: Date }
  | { readonly kind: 'CHALLENGE_NOT_ACTIVE' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };
export interface VerifyChallengeCommand {
  readonly challengeId: string;
  readonly code: unknown;
  readonly client: ClientContext;
}
export type VerifyChallengeResult =
  | {
      readonly kind: 'VERIFIED';
      readonly proofToken: string; // tvp_..., returned once
      readonly proofExpiresAt: Date;
      readonly accountExists: boolean; // CONTACT_PROOF only; false for other purposes
    }
  | { readonly kind: 'VERIFICATION_FAILED' }
  | { readonly kind: 'CHALLENGE_NOT_ACTIVE' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };
export interface ConsumeContactProofCommand {
  readonly proofToken: unknown;
  readonly phoneInput: unknown;
  readonly purpose: ChallengePurpose;
  readonly installationCommitment: Buffer;
  readonly consumedAt: Date;
}
export type ConsumeContactProofResult =
  | {
      readonly kind: 'CONSUMED';
      readonly proofId: string;
      readonly phone: NormalizedPhone;
      readonly fingerprints: ContactFingerprintSet;
    }
  | { readonly kind: 'PROOF_REJECTED' };
export interface VerificationChallengeService {
  start(command: StartChallengeCommand): Promise<StartChallengeResult>;
  resend(command: ResendChallengeCommand): Promise<ResendChallengeResult>;
  verify(command: VerifyChallengeCommand): Promise<VerifyChallengeResult>;
}
/** Runs inside the caller's transaction so consumption commits with what it authorizes. */
export interface ContactProofConsumer {
  consume(
    sql: SqlExecutor,
    command: ConsumeContactProofCommand,
  ): Promise<ConsumeContactProofResult>;
}
/** Read-only port used by verify() to fill accountExists. Wired to ContactPointCommands. */
export interface ContactAccountLookup {
  exists(sql: SqlExecutor, fingerprints: ContactFingerprintSet): Promise<boolean>;
}

// contracts/rate-limit.ts
export type RateLimitDimension =
  | 'CHALLENGE_START_CONTACT_HOUR'
  | 'CHALLENGE_START_CONTACT_DAY'
  | 'CHALLENGE_START_NETWORK_HOUR'
  | 'CHALLENGE_START_INSTALLATION_HOUR'
  | 'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY'
  | 'PASSWORD_FAILURE_ACCOUNT'
  | 'PASSWORD_FAILURE_NETWORK_HOUR'
  | 'RECOVERY_START_ACCOUNT_DAY'
  | 'RECOVERY_START_NETWORK_HOUR'
  | 'REGISTRATION_START_CONTACT_30D'
  | 'REGISTRATION_START_NETWORK_DAY'
  | 'REVERIFICATION_GLOBAL_HOUR'
  | 'DELIVERY_GLOBAL_MINUTE';
export interface RateLimitRule {
  readonly dimension: RateLimitDimension;
  readonly limit: number;
  readonly windowSeconds: number;
}
export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };
export interface RateLimiter {
  /** Consumes one unit atomically and decides. `subject` is already a commitment. */
  consume(dimension: RateLimitDimension, subject: Buffer, at: Date): Promise<RateLimitDecision>;
  /** Reads without consuming. */
  peek(dimension: RateLimitDimension, subject: Buffer, at: Date): Promise<RateLimitDecision>;
}
export type SubjectLabel = 'installation' | 'network-prefix' | 'contact' | 'account' | 'global';
export interface SubjectCommitter {
  /** HMAC-SHA-256 under auth-subject-commitment over "trayvi.auth-subject\0<label>\0<value>". */
  commit(label: SubjectLabel, value: string | Buffer): Buffer;
}

// contracts/delivery.ts
export type DeliveryTemplate =
  | 'OTP_CODE'
  | 'SECURITY_NOTICE_NEW_SESSION'
  | 'SECURITY_NOTICE_PASSWORD_CHANGED'
  | 'SECURITY_NOTICE_RECOVERY_STARTED'
  | 'SECURITY_NOTICE_CONTACT_CHANGE_STARTED';
export interface DeliveryRequest {
  readonly destination: NormalizedPhone;
  readonly template: DeliveryTemplate;
  readonly locale: string;
  readonly code?: string; // OTP_CODE only
  readonly reference: string; // opaque UUIDv7 of the challenge or case
}
export type DeliveryOutcome =
  | { readonly kind: 'SENT'; readonly providerAlias: string; readonly providerMessageId: string }
  | {
      readonly kind: 'NOT_SENT';
      readonly safeCode:
        'BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'TIMEOUT';
    };
export interface OtpDeliveryPort {
  send(request: DeliveryRequest): Promise<DeliveryOutcome>;
}

// contracts/callbacks.ts
export type CallbackKind = 'delivery-status' | 'reverification';
export interface VerifiedCallback {
  readonly providerAlias: string;
  readonly kind: CallbackKind;
  readonly providerEventId: string; // ^[A-Za-z0-9._:-]{1,128}$
  readonly receivedAt: Date;
  readonly fields: Readonly<Record<string, string | number | boolean>>; // allowlisted per kind
}
export interface CallbackHandler {
  readonly kind: CallbackKind;
  /** Field allowlist and types. Unknown fields are dropped before handle(). */
  readonly allowedFields: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
  handle(sql: SqlExecutor, callback: VerifiedCallback): Promise<{ readonly outcomeCode: string }>;
}
export type CallbackIngressResult =
  { readonly kind: 'ACCEPTED' } | { readonly kind: 'DUPLICATE' } | { readonly kind: 'REJECTED' }; // single public shape for every authentication failure
export interface CallbackIngress {
  receive(input: {
    readonly providerAlias: string;
    readonly kind: string;
    readonly timestampHeader: string | undefined;
    readonly signatureHeader: string | undefined;
    readonly rawBody: Buffer;
    readonly receivedAt: Date;
  }): Promise<CallbackIngressResult>;
}

// contracts/outbox.ts
export interface AuthOutboxEvent {
  readonly id: string;
  readonly type: AuthEventType;
  readonly schemaVersion: 1;
  readonly aggregateType: 'auth_contact' | 'auth_challenge'; // outbox_aggregate_type_format forbids '.'
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}
export type AuthEventType = 'auth.contact.bound' | 'auth.contact.replaced' | 'auth.contact.revoked';
export interface OutboxWriter {
  enqueue(sql: SqlExecutor, event: AuthOutboxEvent): Promise<void>;
}

// contracts/tokens.ts
export type OpaqueTokenPrefix = 'tvp_' | 'tva_' | 'tvr_' | 'tvc_'; // tvc_: recovery case handle
export interface OpaqueTokenCodec {
  issue(prefix: OpaqueTokenPrefix): { readonly token: string; readonly hash: Buffer };
  /** Returns undefined for any malformed value, without throwing. */
  hash(prefix: OpaqueTokenPrefix, candidate: unknown): Buffer | undefined;
}
```

### 2.2 Persistence

All tables live in schema `auth`. Status columns use `varchar` plus `CHECK`.
Fingerprints and commitments are `bytea` with `octet_length = 32` checks.

| Migration | Owner    | Objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Runtime grants                                                                                         |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `0012`    | scaffold | `CREATE SCHEMA auth`; `USAGE` to `trayvi_runtime`; `USAGE, CREATE` to `trayvi_migrator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `USAGE`                                                                                                |
| `0013`    | ws-a     | `auth.contact_points` (id, account_id → `accounts.accounts` RESTRICT, channel, role `PRIMARY`, profile, key_version, fingerprint, envelope columns as in Phase 1 `identity_documents`, state, created/replaced/revoked times); `auth.contact_point_fingerprints` (one row per key version, partial unique index on `(channel, profile, key_version, fingerprint) WHERE active`); `auth.contact_point_transitions`; partial unique index `(account_id) WHERE state = 'ACTIVE' AND role = 'PRIMARY'`; guarded functions `auth.bind_primary_contact(...)` and `auth.replace_primary_contact(...)` (`SECURITY DEFINER`, fixed `search_path`) | `SELECT` on non-envelope columns; `EXECUTE` on guarded functions; no direct `INSERT/UPDATE` on `state` |
| `0014`    | ws-b     | `auth.verification_challenges` (id, purpose, destination key_version, destination fingerprint, otp_commitment, otp_key_version, installation_commitment, failed_attempts, resend_count, last_sent_at, expires_at, delivery_outcome_code, state, times); `auth.contact_proofs` (id, challenge_id UNIQUE, purpose, destination fingerprint and key_version, proof_hash UNIQUE, installation_commitment, expires_at, consumed_at); `CHECK` on counters and on `consumed_at` only once; trigger rejecting illegal state edges                                                                                                                | `SELECT, INSERT`; `UPDATE` on state/counter/time columns only                                          |
| `0015`    | ws-c     | `auth.rate_limit_buckets` (dimension, subject, window_start, count, PRIMARY KEY `(dimension, subject, window_start)`), `CHECK (count >= 0)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `SELECT, INSERT, UPDATE (count), DELETE`                                                               |
| `0016`    | ws-d     | `auth.provider_callback_receipts` (id, provider_alias, kind, provider_event_id, received_at, outcome_code, UNIQUE `(provider_alias, kind, provider_event_id)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `SELECT, INSERT`; `UPDATE (outcome_code)`                                                              |

Migration `0013` is the only one that references another schema
(`accounts.accounts`). Down migrations refuse to run when their tables hold rows.

### 2.3 Events and API

Outbox events (aggregate type `auth_contact`; Phase 0's `outbox_aggregate_type_format`
check allows only `^[a-z][a-z0-9_]{0,99}$`), payload allowlist:

| Type                    | Payload fields                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| `auth.contact.bound`    | `contactId`, `accountId`, `reason`                                |
| `auth.contact.replaced` | `contactId`, `previousContactId`, `accountId`, `reason`, `caseId` |
| `auth.contact.revoked`  | `contactId`, `accountId`, `reason`                                |

Challenges emit no outbox events; they are short-lived and carry no business
meaning for other modules.

HTTP routes (all public, all `application/json`, unknown fields rejected):

| Route                                                    | Request body                                        | Success                                                                         |
| -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /api/v1/verification-challenges`                   | `{ purpose: "CONTACT_PROOF", phoneNumber, locale }` | `202 { code: "CHALLENGE_ACCEPTED", challengeId, expiresAt, resendAvailableAt }` |
| `POST /api/v1/verification-challenges/{id}/resend`       | `{ phoneNumber }`                                   | `202 { code: "CHALLENGE_ACCEPTED", resendAvailableAt }`                         |
| `POST /api/v1/verification-challenges/{id}/verify`       | `{ code }`                                          | `200 { proof, proofExpiresAt, accountExists }`                                  |
| `POST /api/v1/provider-callbacks/{providerAlias}/{kind}` | raw signed body, ≤ 16 KiB                           | `200 {}`                                                                        |

Only `CONTACT_PROOF` is accepted on the public start route in this spec. SPEC-002
and SPEC-003 open the other purposes on their own authenticated or case-bound
routes.

Required headers: `X-Trayvi-Installation` (UUID, required on challenge routes);
`X-Trayvi-Timestamp` and `X-Trayvi-Signature` (`v1=<hex>`) on callbacks. The
client network prefix comes from `request.ip` under the trusted-proxy setting
`HTTP_TRUSTED_PROXY_HOPS` (default `0`: `X-Forwarded-For` is ignored). The original
design assumed this setting already existed; the integration amendment in §4 item 9
adds it.

Problem Details codes this spec may emit: `INVALID_CONTACT_FORMAT` (400),
`VERIFICATION_FAILED` (400), `CHALLENGE_NOT_ACTIVE` (409), `RATE_LIMITED` (429
with `Retry-After`), `CALLBACK_REJECTED` (401), `REQUEST_CANNOT_BE_COMPLETED`
(503). `INVALID_CONTACT_FORMAT` exposes the normalization code as a field error
because format does not depend on any account.

## 3. Stream decomposition

| Stream | Responsibility                                      | Owns                                                                                                                                                                                               | Depends on             | Consumes contract                                    | Provides contract                                                                                                  |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ws-a   | Phone normalization, contact crypto, contact points | `modules/auth/src/{domain,application,infrastructure}/contact/`, `modules/auth/test/contact/`                                                                                                      | —                      | runtime, keys, outbox                                | `PhoneNormalizer`, `ContactFingerprinter`, `ContactPointCommands`, `ContactAccountLookup`, `ContactEnvelopeSealer` |
| ws-b   | OTP challenges and contact proofs                   | `modules/auth/src/{domain,application,infrastructure}/challenge/`, `modules/auth/test/challenge/`                                                                                                  | —                      | contact types, rate limit, delivery, tokens, runtime | `VerificationChallengeService`, `ContactProofConsumer`                                                             |
| ws-c   | Rate limiting and subject commitments               | `modules/auth/src/{domain,application,infrastructure}/rate-limit/`, `modules/auth/test/rate-limit/`                                                                                                | —                      | runtime, keys                                        | `RateLimiter`, `SubjectCommitter`                                                                                  |
| ws-d   | Delivery port and provider callbacks                | `modules/auth/src/{domain,application,infrastructure}/delivery/`, `modules/auth/src/{domain,application,infrastructure}/callbacks/`, `modules/auth/test/delivery/`, `modules/auth/test/callbacks/` | —                      | runtime, delivery, callbacks                         | `OtpDeliveryPort` (synthetic), `CallbackIngress`, delivery-status `CallbackHandler`                                |
| ws-e   | HTTP transport, composition, oracle and leak tests  | `apps/api/src/auth/`, `apps/api/test/auth/`                                                                                                                                                        | ws-a, ws-b, ws-c, ws-d | all of the above                                     | routes in §2.3                                                                                                     |

ws-a to ws-d need only the frozen contracts, so they run in wave 1. Their unit
tests use in-memory fakes of the other contracts; their integration tests use
real PostgreSQL for their own tables. ws-e composes the real implementations and
runs in wave 2.

## 4. Integration scaffold

Made on `spec/001-contact-verification-challenges/integration` before streams
start:

1. `modules/auth/package.json` (`@trayvi/auth`, no runtime dependencies),
   `tsconfig.json`, and `src/index.ts`. The index re-exports
   `./contracts/index` and each stream's `index.ts` under
   `src/{domain,application,infrastructure}/{contact,challenge,rate-limit,delivery,callbacks}/`.
   The scaffold creates each of those files as `export {};` so the build passes
   before streams merge. Streams own and replace them.
2. Every file in §2.1 under `modules/auth/src/contracts/`, plus
   `src/infrastructure/shared/` with the `OutboxWriter` that inserts into
   `platform.outbox_events`, the `OpaqueTokenCodec` (`randomBytes(32)`, base64url,
   SHA-256), and the `AuthKeyring` loader that rejects shared key bytes across
   purposes, all with unit tests.
3. Root `tsconfig.json` paths and `vitest.config.ts` alias for `@trayvi/auth`;
   `apps/api/package.json` dependency and `apps/api/tsconfig.json` reference.
4. `scripts/architecture/check-boundaries.ts`: add `auth` to `allowedModules`.
5. `packages/config`: validated settings for the numbering policy, challenge
   policy, rate-limit rules, delivery budget, callback providers (alias and
   secret), and Auth key material references, with tests. Production rejects
   synthetic keys.
6. Redaction: add `tva_`, `tvr_`, `tvp_`, `tvc_` token patterns and `phoneNumber`,
   `code`, `proof`, `password`, `refreshToken`, `accessToken` keys to the
   observability denylist, and the same patterns to `scripts/security`'s secret
   scanner, with tests.
   The scanner explicitly allows only the synthetic PLAN §9.1 token vector, so
   the plan keeps passing `security:secrets`.
7. `apps/api/src/app.module.ts` imports an empty `AuthHttpModule` from
   `apps/api/src/auth/auth-http.module.ts`, which ws-e then owns.
8. Migration `0012`.

Integration amendment (2026-11-03), made before ws-e started because ws-e may change only
`apps/api/src/auth/` and `apps/api/test/auth/`:

9. `HTTP_TRUSTED_PROXY_HOPS` (0–5) in `AppConfig.http.trustedProxyHops`, applied as Fastify
   `trustProxy`, so `request.ip` is the client address behind that many trusted proxies.
10. `loadAuthConfig(environment)` in `packages/config/src/environment.ts` (the only file that may
    read `process.env`), loaded by `createApiApplication` unless a test passes `auth`.
11. Nest `rawBody: true`, so callback routes read `request.rawBody` for signature checks.
12. `AuthHttpModule.register({ config, auth, logger, metrics })`, imported by `AppModule`.

Spec correction: T-D3 writes `auth.verification_challenges` (migration `0014`), so ws-d depends
on ws-b; `streams.json` records that dependency.

## 5. Failure behavior and rollback

- Missing or invalid Auth keys fail startup. A missing lookup version at runtime
  fails the request closed with `REQUEST_CANNOT_BE_COMPLETED` before any write.
- Delivery failure never fails challenge start. The challenge records
  `delivery_outcome_code`; the user may resend after cooldown.
- A database error during verify leaves the attempt counter unchanged only if the
  whole transaction rolled back; the counter increment and the state change are
  one statement, so no partial attempt is possible.
- Callback handler errors roll back the receipt insert, so the provider's retry
  is processed again. A handler that returns an outcome code commits the receipt.
- Down migrations `0013`–`0016` refuse to run on populated tables. `0012` refuses
  to drop a non-empty schema.

## 6. Test strategy

| Requirement      | Test                                                                                                                                                             | Stream     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R-02, R-03       | `test/contact/phone-normalization.unit.test.ts` — vector table, property tests for idempotence                                                                   | ws-a       |
| R-04, R-05, R-06 | `test/contact/contact-protection.unit.test.ts` — vectors, mutation table, collision startup failure                                                              | ws-a       |
| R-07, R-08, R-09 | `test/contact/contact-points.integration.test.ts` — direct-SQL negatives, 50×10 binding race                                                                     | ws-a       |
| R-10, R-11       | `test/challenge/otp.unit.test.ts` — vector, chi-squared on 10^6 codes, constant-time compare use                                                                 | ws-b       |
| R-12, R-16       | `test/challenge/challenge-lifecycle.unit.test.ts` — full transition matrix with controlled clock                                                                 | ws-b       |
| R-13–R-15, R-24  | `test/challenge/challenges.integration.test.ts` — proof binding, 50-way verify race, delivery failure                                                            | ws-b       |
| R-17–R-20        | `test/rate-limit/rate-limit.integration.test.ts` — atomic concurrent increments, windows, simulation                                                             | ws-c       |
| R-23             | `test/delivery/synthetic-delivery.unit.test.ts` — capture shows no code or number outside the request                                                            | ws-d       |
| R-25–R-28        | `test/callbacks/callback-ingress.integration.test.ts` — signature, window, replay, unknown alias, body limit, no raw retention                                   | ws-d       |
| R-19, R-21, R-22 | `apps/api/test/auth/challenge-oracle.integration.test.ts` — 200 samples per class; equal status/schema/headers; size class; median timing difference under 20 ms | ws-e       |
| R-26, R-32       | `apps/api/test/auth/challenge-routes.integration.test.ts` — Problem Details contract snapshots                                                                   | ws-e       |
| R-29, R-30       | each stream's integration suite injects a failure after each write and asserts no orphan rows; event payload key allowlist                                       | ws-a, ws-b |
| R-31             | `apps/api/test/auth/challenge-leak.integration.test.ts` — canary number and code absent from captured logs, spans, metrics, responses, outbox                    | ws-e       |
| R-33             | each owning stream adds its migration to `scripts/db` verification through `db:verify` on the integration branch (T-91)                                          | ws-a..ws-d |
| R-01             | `architecture:check` on every stream branch                                                                                                                      | all        |
