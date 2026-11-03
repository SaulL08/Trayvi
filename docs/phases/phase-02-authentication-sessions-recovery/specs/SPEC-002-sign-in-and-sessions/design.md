# SPEC-002 — Sign-in, credentials, and sessions — Design

Status: Draft  
Requirements: [requirements.md](requirements.md)

## 1. Approach

Sessions, passwords, and sign-in live in Auth subdirectories next to SPEC-001's
capabilities. The guard is a NestJS global guard in `apps/api` that calls an
Auth application service; it holds no rules of its own.

Access tokens are opaque and resolved in PostgreSQL on every request (PLAN §9.1).
Rotation runs in a `SECURITY DEFINER` function, `auth.rotate_refresh_token`,
which locks the family row and applies the PLAN §9.3 rules in SQL. The runtime
role cannot update token or family state directly. This follows the Phase 1
remediation pattern (`0008`), where guarded commands replaced direct state
writes after `P1-AUD-001`.

Registration keeps Phase 1's enrollment service and adds an Auth contact
reservation keyed by the enrollment operation. The phone is entered again at
identity submission, like SPEC-001's proof consumption, so no plaintext phone is
stored between the two steps.

Relies on ADR-007, ADR-008, ADR-009, ADR-011, ADR-019, the pending ADR-013, and
SPEC-001's frozen contracts.

## 2. Contracts frozen before streams start

The scaffold adds these files under `modules/auth/src/contracts/`. SPEC-001
contracts stay unchanged.

### 2.1 Types and ports

```ts
// contracts/session.ts
import type { SqlExecutor } from './runtime';
import type { ClientContext } from './challenge';

export type AssuranceLevel = 'AAL1' | 'AAL2';
export type AuthFactor = 'CONTACT_OTP' | 'PASSWORD' | 'IDENTITY_REVERIFICATION';
export type FamilyRevokeReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'REUSE_DETECTED'
  | 'ACCOUNT_STATE'
  | 'RECOVERY'
  | 'CONTACT_CHANGED'
  | 'PASSWORD_CHANGED'
  | 'SECURITY_POLICY';
export interface SessionPolicy {
  readonly accessTokenSeconds: number; // 300..900
  readonly idleSeconds: number; // 86400..5184000
  readonly absoluteSeconds: number; // >= idleSeconds, <= 15552000
  readonly rotationGraceSeconds: number; // 0..60
  readonly recentAuthSeconds: number; // 60..900
}
export interface IssueSessionCommand {
  readonly accountId: string;
  readonly installationCommitment: Buffer;
  readonly factors: readonly AuthFactor[];
  readonly authenticatedAt: Date;
  readonly correlationId: string;
}
export interface IssuedSession {
  readonly familyId: string;
  readonly sessionId: string;
  readonly accessToken: string; // returned once
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string; // returned once
  readonly familyExpiresAt: Date; // min(idle, absolute)
  readonly newInstallation: boolean;
}
export type RefreshResult =
  | { readonly kind: 'ROTATED'; readonly session: IssuedSession }
  | { readonly kind: 'REAUTHENTICATION_REQUIRED' };
export interface SessionFamilySummary {
  readonly familyId: string;
  readonly createdAt: Date;
  readonly lastRotatedAt: Date;
  readonly assurance: AssuranceLevel;
  readonly current: boolean;
}
export interface SessionCommands {
  issue(sql: SqlExecutor, command: IssueSessionCommand): Promise<IssuedSession>;
  refresh(command: {
    readonly refreshToken: unknown;
    readonly installationCommitment: Buffer;
    readonly at: Date;
    readonly correlationId: string;
  }): Promise<RefreshResult>;
  revokeFamily(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly familyId: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<{ readonly kind: 'REVOKED' | 'NOT_FOUND' }>;
  recordStepUp(
    sql: SqlExecutor,
    command: { readonly familyId: string; readonly factor: AuthFactor; readonly at: Date },
  ): Promise<void>;
  listFamilies(
    accountId: string,
    currentFamilyId: string,
  ): Promise<readonly SessionFamilySummary[]>;
}
export interface AccountSessionRevoker {
  /** Runs in the caller's transaction. Returns the number of families revoked. */
  revokeAllForAccount(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly exceptFamilyId?: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<number>;
}
export type AccessTokenResolution =
  | {
      readonly kind: 'ACTIVE';
      readonly accountId: string;
      readonly sessionId: string;
      readonly familyId: string;
      readonly authenticatedAt: Date;
      readonly assurance: AssuranceLevel;
      readonly factors: readonly AuthFactor[];
    }
  | { readonly kind: 'INVALID' };
export interface AccessTokenResolver {
  resolve(accessToken: unknown, at: Date): Promise<AccessTokenResolution>;
}

// contracts/password.ts
export interface PasswordPolicy {
  readonly minLength: 12;
  readonly maxLength: 128;
}
export type PasswordSetResult =
  | { readonly kind: 'SET' }
  | { readonly kind: 'REJECTED'; readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'COMPROMISED' };
export type PasswordVerifyResult =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'MISMATCH' }
  | { readonly kind: 'NO_CREDENTIAL' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };
export interface PasswordCredentials {
  hasActive(sql: SqlExecutor, accountId: string): Promise<boolean>;
  verify(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly candidate: unknown;
      readonly client: ClientContext;
      readonly at: Date;
    },
  ): Promise<PasswordVerifyResult>;
  set(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly password: unknown;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<PasswordSetResult>;
  remove(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly reason: 'RECOVERY';
      readonly caseId: string;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<void>;
}
export interface CompromisedPasswordChecker {
  isCompromised(password: string): Promise<boolean>;
}

// contracts/principal.ts
export type AccountStatusView =
  'PENDING_IDENTITY' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';
export interface AccountStateReader {
  read(
    sql: SqlExecutor,
    accountId: string,
  ): Promise<{ readonly status: AccountStatusView; readonly version: number } | undefined>;
}
export type RestrictionKind =
  'CONTACT_CHANGE_BLOCKED' | 'PASSWORD_CHANGE_BLOCKED' | 'HIGH_RISK_ACTIONS';
export interface ActiveRestriction {
  readonly kind: RestrictionKind;
  readonly endsAt: Date;
}
export interface RestrictionReader {
  active(sql: SqlExecutor, accountId: string, at: Date): Promise<readonly ActiveRestriction[]>;
}
export interface Principal {
  readonly accountId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly authenticatedAt: Date;
  readonly assurance: AssuranceLevel;
  readonly factors: readonly AuthFactor[];
  readonly accountStatus: Exclude<AccountStatusView, 'SUSPENDED' | 'CLOSED'>;
  readonly accountVersion: number;
  readonly restrictions: readonly ActiveRestriction[];
}
export interface StepUpRequirement {
  readonly maxAgeSeconds: number;
  readonly minAssurance: AssuranceLevel;
}
export type PrincipalResolution =
  | { readonly kind: 'AUTHENTICATED'; readonly principal: Principal }
  | { readonly kind: 'UNAUTHENTICATED' };
export interface PrincipalResolver {
  resolve(accessToken: unknown, at: Date): Promise<PrincipalResolution>;
}
/** Pure; returns undefined when satisfied. */
export type StepUpCheck = (
  principal: Principal,
  requirement: StepUpRequirement,
  at: Date,
) => StepUpRequirement | undefined;

// contracts/registration.ts
export interface RegistrationContactReservations {
  reserve(
    sql: SqlExecutor,
    command: {
      readonly enrollmentOperationId: string;
      readonly proofId: string;
      readonly fingerprints: import('./contact').ContactFingerprintSet;
      readonly expiresAt: Date;
    },
  ): Promise<void>;
  /** Normalizes and fingerprints phoneInput, compares to the reservation, and deletes it. */
  claim(
    sql: SqlExecutor,
    command: { readonly enrollmentOperationId: string; readonly phoneInput: unknown },
  ): Promise<
    | {
        readonly kind: 'MATCHED';
        readonly phone: import('./contact').NormalizedPhone;
        readonly fingerprints: import('./contact').ContactFingerprintSet;
      }
    | { readonly kind: 'NO_MATCH' }
  >;
}

// contracts/outbox.ts additions (AuthEventType union extended by the scaffold)
// 'auth.session.created' | 'auth.session.family-revoked' | 'auth.session.reuse-detected' | 'auth.password.changed'
// aggregateType adds 'auth.session' | 'auth.credential'
```

The scaffold also adds `ChallengePurpose` handling for `STEP_UP` to the HTTP
layer: `POST /api/v1/sessions/current/step-up` starts a `STEP_UP` challenge to
the principal's primary contact, read with `ContactPointCommands.activePrimary`.

### 2.2 Persistence

| Migration | Owner | Objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Runtime grants                                                                                                                                                              |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0016`    | ws-a  | `auth.session_families` (id, account_id → accounts RESTRICT, installation_commitment, factors text[], assurance, authenticated_at, idle_expires_at, absolute_expires_at, state, revoke_reason, revoked_at, version); `auth.sessions` (id, family_id, access_token_hash UNIQUE, issued_at, expires_at, state); `auth.refresh_tokens` (id, family_id, predecessor_id UNIQUE, token_hash UNIQUE, state, issued_at, rotated_at, first_used_at); partial unique index `(family_id) WHERE state = 'ISSUED'`; terminal-state trigger; functions `auth.issue_session_family`, `auth.rotate_refresh_token`, `auth.revoke_session_families`, `auth.record_step_up` (`SECURITY DEFINER`, fixed `search_path`); index on `(account_id) WHERE state = 'ACTIVE'` | `SELECT` on non-hash columns plus `access_token_hash` lookup through `auth.resolve_access_token(bytea, timestamptz)`; `EXECUTE` on the functions; no `INSERT/UPDATE/DELETE` |
| `0017`    | ws-b  | `auth.password_credentials` (id, account_id, algorithm `scrypt`, parameter_version, salt, hash, state `ACTIVE/REPLACED/REMOVED`, created_at, ended_at); partial unique index `(account_id) WHERE state = 'ACTIVE'`; `auth.password_credential_transitions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `SELECT, INSERT`; `UPDATE (state, ended_at)`                                                                                                                                |
| `0018`    | ws-c  | `auth.registration_contact_reservations` (enrollment_operation_id PK → `accounts.account_creation_operations` CASCADE, proof_id → `auth.contact_proofs`, key_version, fingerprint, expires_at)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `SELECT, INSERT, DELETE`                                                                                                                                                    |

The runtime role can read `salt` and `hash` only through `auth.password_credentials`
grants given to the Auth workload; reporting roles get nothing on these tables.

### 2.3 Events and API

| Event                         | Aggregate         | Payload fields                                          |
| ----------------------------- | ----------------- | ------------------------------------------------------- |
| `auth.session.created`        | `auth.session`    | `familyId`, `accountId`, `assurance`, `newInstallation` |
| `auth.session.family-revoked` | `auth.session`    | `familyId`, `accountId`, `reason`                       |
| `auth.session.reuse-detected` | `auth.session`    | `familyId`, `accountId`                                 |
| `auth.password.changed`       | `auth.credential` | `accountId`, `change` (`SET`, `REPLACED`, `REMOVED`)    |

| Route                                               | Auth                                  | Request                                                                              | Success                                                                          |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST /api/v1/sessions`                             | public                                | `{ proof, phoneNumber, password? }`                                                  | `201 { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }` |
| `POST /api/v1/sessions/refresh`                     | public                                | `{ refreshToken }`                                                                   | `200` same shape                                                                 |
| `DELETE /api/v1/sessions/current`                   | principal                             | —                                                                                    | `204`                                                                            |
| `GET /api/v1/sessions`                              | principal                             | —                                                                                    | `200 { items: SessionFamilySummary[] }`                                          |
| `DELETE /api/v1/sessions/{familyId}`                | principal                             | —                                                                                    | `204` (also for families not owned, to avoid an ID oracle)                       |
| `POST /api/v1/sessions/revoke-others`               | principal                             | —                                                                                    | `200 { revoked }`                                                                |
| `POST /api/v1/sessions/current/step-up`             | principal                             | `{ locale }`                                                                         | `202 { challengeId, expiresAt, resendAvailableAt }`                              |
| `POST /api/v1/sessions/current/step-up/{id}/verify` | principal                             | `{ code }`                                                                           | `204`                                                                            |
| `GET /api/v1/accounts/me`                           | principal                             | —                                                                                    | `200 { accountStatus, assurance, restrictions }`                                 |
| `PUT /api/v1/credentials/password`                  | principal + step-up AAL1 within 300 s | `{ password }`                                                                       | `204`                                                                            |
| `POST /api/v1/account-registrations`                | public                                | `{ proof, phoneNumber }` + `Idempotency-Key`                                         | Phase 1 `ACCOUNT_CREATION_ACCEPTED` envelope                                     |
| `POST /api/v1/account-registrations/{id}/identity`  | holder of operation                   | `{ phoneNumber, country, issuer, documentType, documentNumber }` + `Idempotency-Key` | Phase 1 `IDENTITY_SUBMISSION_ACCEPTED` envelope                                  |

Problem Details codes: `AUTHENTICATION_FAILED` (401), `AUTHENTICATION_REQUIRED`
(401), `REAUTHENTICATION_REQUIRED` (401), `STEP_UP_REQUIRED` (403, with
`requiredAssurance` and `maxAgeSeconds`), `VERIFICATION_FAILED` (400),
`IDEMPOTENCY_CONFLICT` (409), `RATE_LIMITED` (429), `REQUEST_CANNOT_BE_COMPLETED`
(503), and the Phase 1 codes on registration routes. Validation errors for
`password` say only `TOO_SHORT`, `TOO_LONG`, or `COMPROMISED`.

## 3. Stream decomposition

| Stream | Responsibility                                        | Owns                                                                                                                                 | Depends on       | Consumes contract                            | Provides contract                                                            |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| ws-a   | Session families, tokens, rotation, revocation        | `modules/auth/src/{domain,application,infrastructure}/session/`, `modules/auth/test/session/`                                        | —                | runtime, tokens, outbox                      | `SessionCommands`, `AccountSessionRevoker`, `AccessTokenResolver`            |
| ws-b   | Password credential                                   | `modules/auth/src/{domain,application,infrastructure}/password/`, `modules/auth/test/password/`                                      | —                | runtime, rate limit, outbox                  | `PasswordCredentials`, synthetic `CompromisedPasswordChecker`                |
| ws-c   | Accounts seam and registration binding                | `modules/auth/src/{application,infrastructure}/registration/`, `apps/api/src/phase-01/`, `apps/api/test/registration/`               | —                | contact, challenge, rate limit, registration | `AccountStateReader`, `RegistrationContactReservations`, registration routes |
| ws-d   | Guard, principal, step-up, route inventory            | `modules/auth/src/{domain,application}/principal/`, `apps/api/src/auth/guard/`, `apps/api/test/auth/guard/`                          | ws-a, ws-c       | session, principal                           | `PrincipalResolver`, `StepUpCheck`, global guard, empty `RestrictionReader`  |
| ws-e   | Sign-in service and session, password, account routes | `modules/auth/src/application/sign-in/`, `modules/auth/test/sign-in/`, `apps/api/src/auth/sessions/`, `apps/api/test/auth/sessions/` | ws-a, ws-b, ws-d | everything above                             | routes in §2.3 except registration                                           |

ws-c owns `apps/api/src/phase-01/` because the enrollment transaction lives
there. It changes the Phase 1 store only to call the reservation and binding
ports inside the existing transaction and to add `AccountStateReader`. Any change
to Phase 1 public envelopes is outside its remit and needs a spec review.

Waves: 1 = ws-a, ws-b, ws-c; 2 = ws-d; 3 = ws-e.

## 4. Integration scaffold

On `spec/002-sign-in-and-sessions/integration`:

1. The contracts in §2.1 and the outbox type extensions.
2. Empty `index.ts` entry files for each new stream directory, re-exported from
   `modules/auth/src/index.ts`.
3. `apps/api/src/auth/auth-http.module.ts` imports empty `GuardModule`,
   `SessionsHttpModule`, and `RegistrationHttpModule` placeholders from
   `auth/guard/`, `auth/sessions/`, and `phase-01/`, and `app.module.ts` registers
   the guard as `APP_GUARD`. Until ws-d merges, the placeholder guard allows only
   the public routes and denies everything else.
4. `apps/api/src/auth/public-routes.ts`: the frozen public-route allowlist from
   PLAN §9.4 as `(method, path template)` pairs, including both registration
   routes. ws-d reads it; no stream edits it.
5. `packages/config`: `SessionPolicy`, password semaphore size, and
   compromised-password list path, with tests.
6. `scripts/db` verification placeholders for migrations `0016`–`0018`.

## 5. Failure behavior and rollback

- Resolver errors (database unavailable) deny the request with
  `REQUEST_CANNOT_BE_COMPLETED`; the guard never fails open.
- Rotation failures roll back fully; the client keeps its previous refresh token,
  which stays `ISSUED`.
- Security notices are sent after commit through the delivery port. Failure is
  logged with a safe code and does not affect the session.
- Registration failures roll back the reservation, contact binding, and Phase 1
  rows together.
- Down migrations refuse to run on populated tables.

## 6. Test strategy

| Requirement           | Test                                                                                                                                      | Stream      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R-01                  | `test/session/token-codec.unit.test.ts` — vector, prefix, malformed inputs                                                                | ws-a        |
| R-02–R-07             | `test/session/session-lifecycle.integration.test.ts` — controlled clock, each grace condition alone, direct-SQL negatives                 | ws-a        |
| R-08                  | `test/session/refresh-race.integration.test.ts` — 100 connections × 10 rounds, machine-readable results                                   | ws-a        |
| R-09, R-10            | `test/session/revocation.integration.test.ts` — revoke inside a caller transaction that commits and one that rolls back                   | ws-a        |
| R-11–R-14             | `test/password/password.integration.test.ts` — parameters, rehash, NFC, policy, limits, single active                                     | ws-b        |
| R-16–R-20             | `apps/api/test/registration/registration.integration.test.ts` — binding, re-entry mismatch, duplicate contact and document parity, limits | ws-c        |
| R-21–R-25             | `apps/api/test/auth/guard/guard.integration.test.ts` and `route-inventory.unit.test.ts`                                                   | ws-d        |
| R-15, R-24, R-26–R-29 | `apps/api/test/auth/sessions/sign-in.integration.test.ts`, `step-up.integration.test.ts`, `password-route.integration.test.ts`            | ws-e        |
| R-30                  | event key allowlist assertions in ws-a and ws-b integration suites                                                                        | ws-a, ws-b  |
| R-31                  | `apps/api/test/auth/sessions/session-leak.integration.test.ts` — canary capture                                                           | ws-e        |
| R-32                  | integration task T-91                                                                                                                     | integration |
