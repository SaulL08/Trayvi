# SPEC-003 — Account recovery and contact change — Design

Status: Draft  
Requirements: [requirements.md](requirements.md)

## 1. Approach

Recovery and contact change share one case model in Auth
(`auth.recovery_cases` with `kind`), one state machine, and one completion path.
The application services orchestrate SPEC-001 and SPEC-002 ports; they hold no
crypto or session logic of their own.

Identity owns re-verification because only Identity can compare a presenter's
document with the account's bound claims. It exposes a narrow application port.
It does not import Auth, and Auth does not import Identity. `apps/api` wires the
re-verification callback handler between them.

Completion happens in the worker after cooling-off, so the worker gains a
PostgreSQL pool and a small interval job runner in the integration scaffold.

Relies on ADR-008, ADR-011, ADR-012, ADR-019, the pending ADR-013, and the
SPEC-001 and SPEC-002 contracts.

## 2. Contracts frozen before streams start

### 2.1 Types and ports

```ts
// modules/auth/src/contracts/recovery.ts
import type { SqlExecutor } from './runtime';
import type { ClientContext } from './challenge';
import type { ContactFingerprintSet, SealedPhone } from './contact';
import type { Principal } from './principal';

export type CaseKind = 'RECOVERY' | 'CONTACT_CHANGE';
export type RecoveryTier = 1 | 2 | 3;
export type RecoveryCaseState =
  'OPEN' | 'AWAITING_PROOFS' | 'COOLING_OFF' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
export type CaseEndReason =
  | 'COMPLETED'
  | 'REVERIFICATION_NOT_MATCHED'
  | 'IDENTITY_NOT_ESTABLISHED'
  | 'PROOF_FAILED'
  | 'ACCOUNT_STATE'
  | 'STALE_CONTACT'
  | 'CONTACT_ALREADY_BOUND'
  | 'SUPERSEDED'
  | 'OWNER_CANCELLED'
  | 'EXPIRED';
export type RecoveryProofKind =
  'CURRENT_CONTACT_OTP' | 'NEW_CONTACT_OTP' | 'IDENTITY_REVERIFICATION' | 'PASSWORD';
export interface RecoveryPolicy {
  readonly tier1CoolingOffSeconds: number; // default 86400
  readonly tier23CoolingOffSeconds: number; // default 259200
  readonly contactChangeCoolingOffSeconds: number; // default 86400
  readonly recoveryRestrictionSeconds: {
    readonly 1: number;
    readonly 2: number;
    readonly 3: number;
  }; // 259200, 604800, 604800
  readonly contactChangeRestrictionSeconds: number; // default 259200
  readonly caseLifetimeSeconds: number; // default 604800; must exceed every cooling-off
}
export type RecoveryEntry =
  | { readonly kind: 'FORGOT_PASSWORD'; readonly phoneInput: unknown }
  | { readonly kind: 'LOST_NUMBER'; readonly previousPhoneInput: unknown }
  | { readonly kind: 'DUPLICATE_DOCUMENT'; readonly candidateReference: unknown };
export interface StartRecoveryResult {
  readonly kind: 'ACCEPTED';
  readonly caseHandle: string; // tvc_..., returned once
  readonly requiredProofs: readonly RecoveryProofKind[]; // tier-shaped; decoys get the shape of the entry kind
}
export type SubmitProofInput =
  | {
      readonly kind: 'CURRENT_CONTACT_OTP';
      readonly proofToken: unknown;
      readonly phoneInput: unknown;
    }
  | { readonly kind: 'NEW_CONTACT_OTP'; readonly proofToken: unknown; readonly phoneInput: unknown }
  | { readonly kind: 'PASSWORD'; readonly password: unknown }
  | { readonly kind: 'IDENTITY_REVERIFICATION' }; // starts the provider handoff
export type SubmitProofResult =
  | {
      readonly kind: 'PROOF_ACCEPTED';
      readonly remaining: readonly RecoveryProofKind[];
      readonly reverificationHandoff?: string; // opaque provider handoff reference
    }
  | { readonly kind: 'PROOF_REJECTED' } // single shape for every proof failure
  | { readonly kind: 'CASE_NOT_ACTIVE' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };
export interface RecoveryService {
  start(entry: RecoveryEntry, client: ClientContext): Promise<StartRecoveryResult>;
  submitProof(
    caseHandle: unknown,
    proof: SubmitProofInput,
    client: ClientContext,
  ): Promise<SubmitProofResult>;
  cancelByPrincipal(
    principal: Principal,
    correlationId: string,
  ): Promise<{ readonly kind: 'CANCELLED' | 'NOTHING_TO_CANCEL' }>;
  cancelByContactProof(
    proofToken: unknown,
    phoneInput: unknown,
    client: ClientContext,
  ): Promise<{ readonly kind: 'ACCEPTED' }>;
  recordReverificationOutcome(
    sql: SqlExecutor,
    outcome: {
      readonly caseReference: string;
      readonly result: 'MATCHED' | 'NOT_MATCHED';
      readonly at: Date;
    },
  ): Promise<void>;
}
export interface ContactChangeService {
  start(
    principal: Principal,
    input: { readonly proofToken: unknown; readonly phoneInput: unknown },
    client: ClientContext,
  ): Promise<
    | {
        readonly kind: 'ACCEPTED';
        readonly coolingOffEndsAt: Date;
        readonly reverificationHandoff?: string;
      }
    | { readonly kind: 'ACTION_RESTRICTED' }
    | {
        readonly kind: 'STEP_UP_REQUIRED';
        readonly requirement: import('./principal').StepUpRequirement;
      }
    | { readonly kind: 'PROOF_REJECTED' }
  >;
}
export interface CaseCompletionJob {
  /** Claims due cases with SKIP LOCKED; returns counts by end reason. */
  completeDue(limit: number): Promise<Readonly<Partial<Record<CaseEndReason, number>>>>;
  expireStale(limit: number): Promise<number>;
}
export interface RestrictionCommands {
  apply(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly kinds: readonly import('./principal').RestrictionKind[];
      readonly sourceCaseId: string;
      readonly startsAt: Date;
      readonly endsAt: Date;
      readonly correlationId: string;
    },
  ): Promise<void>;
}

// modules/identity/src/application/reverification/contracts.ts
export type ReverificationPurpose = 'ACCOUNT_RECOVERY' | 'CONTACT_CHANGE';
export interface IdentityReverificationPort {
  /** targetIdentityId undefined means decoy: the outcome can only be NOT_MATCHED. */
  open(
    sql: {
      query: (
        text: string,
        values: readonly unknown[],
      ) => Promise<{ rows: readonly object[]; rowCount: number }>;
    },
    request: {
      readonly targetAccountId?: string;
      readonly purpose: ReverificationPurpose;
      readonly caseReference: string; // Auth case UUID, opaque to Identity
      readonly at: Date;
    },
  ): Promise<{ readonly reverificationId: string; readonly handoff: string }>;
  resolve(
    sql: {
      query: (
        text: string,
        values: readonly unknown[],
      ) => Promise<{ rows: readonly object[]; rowCount: number }>;
    },
    providerOutcome: {
      readonly reverificationId: string;
      readonly providerDecision: 'PASSED' | 'FAILED';
      readonly presenterDocument?: {
        readonly country: string;
        readonly issuer: string;
        readonly documentType: string;
        readonly documentNumber: string; // in memory only; never persisted or logged
      };
      readonly at: Date;
    },
  ): Promise<
    | { readonly caseReference: string; readonly result: 'MATCHED' | 'NOT_MATCHED' }
    | { readonly kind: 'UNKNOWN' }
  >;
}
export interface ReverificationProvider {
  startSession(reverificationId: string): Promise<{ readonly handoff: string }>;
}
```

Identity defines its own structural `SqlExecutor` shape so it imports nothing
from Auth. `targetAccountId` resolves to the identity inside Identity; Auth never
sees identity IDs.

SPEC-001 already defines `REVERIFICATION_GLOBAL_HOUR`, `ContactEnvelopeSealer`,
the `tvc_` prefix, and the `RECOVERY_NEW_CONTACT`, `RECOVERY_CANCEL`, and
`CONTACT_CHANGE_NEW` challenge purposes. This spec opens those purposes on the
routes below; it changes no earlier contract.

### 2.2 Persistence

| Migration | Owner | Objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Runtime grants                                                                                                           |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `0020`    | ws-a  | `auth.recovery_cases` (id, kind, account_id nullable, expected_contact_id, tier, state, required_proofs text[], accepted_proofs text[], handle_hash UNIQUE, sealed pending contact columns, pending fingerprints and key version, reverification_id, cooling_off_ends_at, expires_at, end_reason, version, times); partial unique index `(account_id) WHERE state IN ('OPEN','AWAITING_PROOFS','COOLING_OFF')`; `auth.recovery_case_transitions`; `auth.account_restrictions` (id, account_id, kind, source_case_id, starts_at, ends_at, lifted_at); state-edge trigger; guarded function `auth.transition_recovery_case` | `SELECT`; `INSERT` on cases, transitions, restrictions; `EXECUTE` on the guarded function; no direct `UPDATE` of `state` |
| `0021`    | ws-b  | `identity.reverification_requests` (id, target_identity_id nullable, purpose, case_reference, state `OPEN/MATCHED/NOT_MATCHED/EXPIRED`, opened/resolved times); guarded function `identity.resolve_reverification` that reads bound claims and writes only this table                                                                                                                                                                                                                                                                                                                                                     | `SELECT, INSERT`; `EXECUTE` on the function; no grant on other identity tables beyond Phase 1                            |

### 2.3 Events and API

| Event                               | Aggregate       | Payload fields                                 |
| ----------------------------------- | --------------- | ---------------------------------------------- |
| `auth.recovery.opened`              | `auth_recovery` | `caseId`, `kind`, `tier` (real cases only)     |
| `auth.recovery.cooling_off_started` | `auth_recovery` | `caseId`, `accountId`, `coolingOffEndsAt`      |
| `auth.recovery.cancelled`           | `auth_recovery` | `caseId`, `accountId`, `reason`                |
| `auth.recovery.completed`           | `auth_recovery` | `caseId`, `accountId`, `kind`, `tier`          |
| `auth.recovery.rejected`            | `auth_recovery` | `caseId`, `accountId`, `reason`                |
| `auth.restriction.applied`          | `auth_account`  | `accountId`, `kinds`, `endsAt`, `sourceCaseId` |

Decoy cases emit no events. Events never carry the handle, phone, or fingerprint.

| Route                                           | Auth                        | Request                                                    | Success                                                         |
| ----------------------------------------------- | --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/v1/recovery-cases`                   | public                      | `{ entry: { kind, phoneNumber? , candidateReference? } }`  | `202 { code: "RECOVERY_ACCEPTED", caseHandle, requiredProofs }` |
| `POST /api/v1/recovery-cases/proofs`            | `Authorization: Case tvc_…` | `SubmitProofInput` as JSON                                 | `200 { remaining, reverificationHandoff? }`                     |
| `POST /api/v1/recovery-cases/challenges`        | `Authorization: Case tvc_…` | `{ purpose: "RECOVERY_NEW_CONTACT", phoneNumber, locale }` | `202` SPEC-001 challenge envelope                               |
| `POST /api/v1/recovery-cases/cancel-challenges` | public                      | `{ phoneNumber, locale }`                                  | `202` SPEC-001 challenge envelope (`RECOVERY_CANCEL`)           |
| `POST /api/v1/recovery-cases/cancel`            | public or principal         | `{ proof, phoneNumber }` or none with a principal          | `202 { code: "RECOVERY_ACCEPTED" }`                             |
| `POST /api/v1/contact-changes/challenges`       | principal                   | `{ phoneNumber, locale }`                                  | `202` SPEC-001 challenge envelope (`CONTACT_CHANGE_NEW`)        |
| `POST /api/v1/contact-changes`                  | principal + step-up         | `{ proof, phoneNumber }`                                   | `202 { coolingOffEndsAt, reverificationHandoff? }`              |

The case handle travels in a header, never in the URL. The SPEC-002 public-route
allowlist gains the public routes above; the case-handle routes are authenticated
by the handle, not by a principal.

## 3. Stream decomposition

| Stream | Responsibility                                       | Owns                                                                                                                                               | Depends on | Consumes contract                                      | Provides contract                                                                                          |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| ws-a   | Case model, tier policy, services, restrictions      | `modules/auth/src/{domain,application,infrastructure}/recovery/`, `modules/auth/test/recovery/`                                                    | —          | SPEC-001/002 ports, `IdentityReverificationPort` shape | `RecoveryService`, `ContactChangeService`, `CaseCompletionJob`, `RestrictionCommands`, `RestrictionReader` |
| ws-b   | Identity re-verification seam and synthetic provider | `modules/identity/src/application/reverification/`, `modules/identity/src/infrastructure/reverification/`, `modules/identity/test/reverification/` | —          | Phase 1 Identity internals                             | `IdentityReverificationPort`, synthetic `ReverificationProvider`                                           |
| ws-c   | HTTP routes, callback handler, restriction wiring    | `apps/api/src/auth/recovery/`, `apps/api/test/auth/recovery/`, `apps/api/src/auth/guard/restriction-wiring.ts`                                     | ws-a, ws-b | all of the above                                       | routes in §2.3, re-verification `CallbackHandler`                                                          |
| ws-d   | Worker completion and expiry jobs                    | `apps/worker/src/recovery/`, `apps/worker/test/recovery/`                                                                                          | ws-a       | `CaseCompletionJob`                                    | scheduled jobs                                                                                             |

ws-a unit tests use a fake `IdentityReverificationPort`; its integration tests
use real PostgreSQL and fakes for the provider. Waves: 1 = ws-a, ws-b; 2 = ws-c,
ws-d.

## 4. Integration scaffold

On `spec/003-account-recovery/integration`:

1. `modules/auth/src/contracts/recovery.ts`, the `auth.recovery` and
   `auth.account` outbox type extensions, and empty entry files for `recovery/`
   directories.
2. `modules/identity/src/application/reverification/contracts.ts` and empty
   entry files, re-exported from `modules/identity/src/index.ts`.
3. `apps/api/src/auth/guard/restriction-wiring.ts` exporting the SPEC-002 empty
   `RestrictionReader`; the guard module imports it. ws-c replaces it.
4. The public-route allowlist additions.
5. `apps/worker`: dependencies on `pg`, `@trayvi/auth`, and `@trayvi/config`
   database settings; a pool with graceful shutdown; an interval job runner with
   overlap prevention, bounded runtime, and safe-code logging, with tests; and an
   empty `RecoveryJobsModule` from `apps/worker/src/recovery/` that ws-d owns.
6. `packages/config`: `RecoveryPolicy`, job intervals and batch size,
   `REVERIFICATION_GLOBAL_HOUR`, and the re-verification provider callback alias.
7. `scripts/db` verification placeholders for `0020`–`0021`.

## 5. Failure behavior and rollback

- Any failure inside completion rolls back the whole case transaction; the job
  retries on the next run. Repeated failure for one case is logged with a safe
  code and the case ID only.
- A re-verification outcome for an unknown or terminal case is acknowledged and
  ignored; the receipt still commits, so the provider stops retrying.
- If the provider handoff fails, the proof submission returns `PROOF_REJECTED`
  and the case stays in `AWAITING_PROOFS` until it expires or is superseded.
- Notices are best effort after commit and never block a state change.
- Down migrations refuse to run on populated tables.

## 6. Test strategy

| Requirement      | Test                                                                                                                                        | Stream      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R-01, R-02, R-04 | `test/recovery/recovery-lifecycle.unit.test.ts` (matrix) and `recovery-cases.integration.test.ts` (direct-SQL negatives, supersede)         | ws-a        |
| R-03, R-05       | `test/recovery/recovery-start.integration.test.ts` — real versus decoy row shape, limits shared                                             | ws-a        |
| R-06–R-10        | `test/recovery/recovery-proofs.integration.test.ts` — every tier, every proof failure, identity precondition                                | ws-a        |
| R-11             | `test/recovery/recovery-cancel.integration.test.ts`                                                                                         | ws-a        |
| R-12–R-14, R-18  | `test/recovery/recovery-completion.integration.test.ts` — injected failure after each write, row counts, every rejection reason             | ws-a        |
| R-15, R-16, R-17 | `apps/api/test/auth/recovery/contact-change.integration.test.ts`, `restrictions.integration.test.ts`                                        | ws-c        |
| R-19–R-21        | `modules/identity/test/reverification/reverification.integration.test.ts` — match, mismatch, decoy, runtime-role negatives, canary document | ws-b        |
| R-22             | `apps/api/test/auth/recovery/reverification-callback.integration.test.ts` — through `CallbackIngress`, replay                               | ws-c        |
| R-23, R-24       | `apps/worker/test/recovery/recovery-jobs.integration.test.ts` — two workers, 200 due cases, no double completion                            | ws-d        |
| R-25, R-26       | event allowlist and canary assertions in ws-a and ws-d suites                                                                               | ws-a, ws-d  |
| R-27             | `apps/api/test/auth/recovery/recovery-oracle.integration.test.ts` — real versus decoy responses                                             | ws-c        |
| R-28             | integration task T-91                                                                                                                       | integration |
