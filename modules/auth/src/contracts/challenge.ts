import type { ContactFingerprintSet, NormalizedPhone, PhoneNormalizationFailure } from './contact';
import type { SqlExecutor } from './runtime';

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
