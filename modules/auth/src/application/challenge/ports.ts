import type { ChallengePurpose, ChallengeState } from '../../contracts/challenge';
import type { SqlExecutor } from '../../contracts/runtime';

export interface ChallengeRecord {
  readonly id: string;
  readonly purpose: ChallengePurpose;
  readonly destinationKeyVersion: string;
  readonly destinationFingerprint: Buffer;
  readonly otpCommitment: Buffer;
  readonly otpKeyVersion: string;
  readonly installationCommitment: Buffer;
  readonly failedAttempts: number;
  readonly maxFailedAttempts: number;
  readonly resendCount: number;
  readonly maxResends: number;
  readonly lastSentAt: Date;
  readonly expiresAt: Date;
  readonly state: ChallengeState;
}

export type NewChallengeRecord = Omit<
  ChallengeRecord,
  'failedAttempts' | 'resendCount' | 'state'
> & {
  readonly createdAt: Date;
};

export interface ProofRecord {
  readonly id: string;
  readonly challengeId: string;
  readonly challengeState: ChallengeState;
  readonly purpose: ChallengePurpose;
  readonly destinationKeyVersion: string;
  readonly destinationFingerprint: Buffer;
  readonly installationCommitment: Buffer;
  readonly expiresAt: Date;
  readonly consumedAt: Date | undefined;
}

export interface NewProofRecord {
  readonly id: string;
  readonly challengeId: string;
  readonly purpose: ChallengePurpose;
  readonly destinationKeyVersion: string;
  readonly destinationFingerprint: Buffer;
  readonly proofHash: Buffer;
  readonly installationCommitment: Buffer;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type DeliveryOutcomeCode =
  'SENT' | 'BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'TIMEOUT';

/** Persistence port for challenges and proofs; every method runs on the caller's executor. */
export interface ChallengeStore {
  /** Cancels every PENDING challenge for the destination and purpose. */
  cancelPending(
    sql: SqlExecutor,
    purpose: ChallengePurpose,
    destinationKeyVersion: string,
    destinationFingerprint: Buffer,
    at: Date,
  ): Promise<number>;
  /** Returns false when another PENDING challenge for the same destination won the insert. */
  insert(sql: SqlExecutor, record: NewChallengeRecord): Promise<boolean>;
  lock(sql: SqlExecutor, challengeId: string): Promise<ChallengeRecord | undefined>;
  transition(
    sql: SqlExecutor,
    challengeId: string,
    from: ChallengeState,
    to: ChallengeState,
    at: Date,
  ): Promise<boolean>;
  recordResend(
    sql: SqlExecutor,
    challengeId: string,
    otpCommitment: Buffer,
    otpKeyVersion: string,
    at: Date,
  ): Promise<boolean>;
  /** Counts one failure and exhausts at the cap in a single statement. */
  recordFailure(
    sql: SqlExecutor,
    challengeId: string,
    at: Date,
  ): Promise<{ readonly failedAttempts: number; readonly state: ChallengeState } | undefined>;
  recordDeliveryOutcome(
    sql: SqlExecutor,
    challengeId: string,
    outcome: DeliveryOutcomeCode,
    at: Date,
  ): Promise<void>;
  insertProof(sql: SqlExecutor, proof: NewProofRecord): Promise<void>;
  lockProof(sql: SqlExecutor, proofHash: Buffer): Promise<ProofRecord | undefined>;
  /** Marks the proof consumed and its challenge CONSUMED; false if either already moved. */
  consumeProof(sql: SqlExecutor, proofId: string, challengeId: string, at: Date): Promise<boolean>;
}

/** OTP generation and keyed commitment (PLAN §8.1). */
export interface OtpCodes {
  generate(): string;
  commit(
    challengeId: string,
    purpose: ChallengePurpose,
    code: string,
  ): { readonly commitment: Buffer; readonly keyVersion: string };
  matches(
    challengeId: string,
    purpose: ChallengePurpose,
    candidate: unknown,
    stored: { readonly commitment: Buffer; readonly keyVersion: string },
  ): boolean;
}
