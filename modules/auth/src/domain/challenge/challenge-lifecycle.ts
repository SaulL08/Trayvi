import type { ChallengePolicy, ChallengePurpose, ChallengeState } from '../../contracts/challenge';

export const CHALLENGE_PURPOSES: readonly ChallengePurpose[] = [
  'CONTACT_PROOF',
  'STEP_UP',
  'RECOVERY_NEW_CONTACT',
  'RECOVERY_CANCEL',
  'CONTACT_CHANGE_NEW',
];

/** PLAN §8.2 bounds. */
export const CHALLENGE_POLICY_BOUNDS: Readonly<
  Record<keyof ChallengePolicy, readonly [minimum: number, maximum: number]>
> = {
  codeLifetimeSeconds: [120, 600],
  maxFailedAttempts: [3, 10],
  maxResends: [0, 5],
  resendCooldownSeconds: [15, 120],
  proofLifetimeSeconds: [120, 900],
};

export class ChallengePolicyError extends Error {
  constructor() {
    super('CHALLENGE_POLICY_INVALID');
    this.name = 'ChallengePolicyError';
  }
}

export function validateChallengePolicy(policy: ChallengePolicy): ChallengePolicy {
  for (const [field, [minimum, maximum]] of Object.entries(CHALLENGE_POLICY_BOUNDS) as [
    keyof ChallengePolicy,
    readonly [number, number],
  ][]) {
    const value = policy[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new ChallengePolicyError();
    }
  }
  return Object.freeze({ ...policy });
}

/** PLAN §5.3: every other edge is rejected and terminal states never reopen. */
const EDGES: Readonly<Record<ChallengeState, readonly ChallengeState[]>> = {
  PENDING: ['VERIFIED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED'],
  VERIFIED: ['CONSUMED', 'EXPIRED'],
  CONSUMED: [],
  EXPIRED: [],
  EXHAUSTED: [],
  CANCELLED: [],
};

export function canTransition(from: ChallengeState, to: ChallengeState): boolean {
  return EDGES[from].includes(to);
}

export interface ChallengeSnapshot {
  readonly state: ChallengeState;
  readonly failedAttempts: number;
  readonly maxFailedAttempts: number;
  readonly resendCount: number;
  readonly maxResends: number;
  readonly lastSentAt: Date;
  readonly expiresAt: Date;
}

export function newChallengeTimes(
  policy: ChallengePolicy,
  now: Date,
): { readonly expiresAt: Date; readonly resendAvailableAt: Date } {
  return {
    expiresAt: new Date(now.getTime() + policy.codeLifetimeSeconds * 1_000),
    resendAvailableAt: new Date(now.getTime() + policy.resendCooldownSeconds * 1_000),
  };
}

export function proofExpiry(policy: ChallengePolicy, now: Date): Date {
  return new Date(now.getTime() + policy.proofLifetimeSeconds * 1_000);
}

/**
 * A PENDING challenge at or past its code expiry must move to EXPIRED. A VERIFIED challenge is
 * governed by its proof's lifetime instead (see isProofExpired), which may outlast the code.
 */
export function isExpired(snapshot: ChallengeSnapshot, now: Date): boolean {
  return snapshot.state === 'PENDING' && now.getTime() >= snapshot.expiresAt.getTime();
}

export function isProofExpired(proofExpiresAt: Date, now: Date): boolean {
  return now.getTime() >= proofExpiresAt.getTime();
}

export type ResendDecision =
  | { readonly kind: 'ALLOWED'; readonly resendAvailableAt: Date }
  | { readonly kind: 'COOLDOWN'; readonly retryAfterSeconds: number }
  | { readonly kind: 'NOT_ACTIVE'; readonly expire: boolean };

export function decideResend(
  snapshot: ChallengeSnapshot,
  policy: ChallengePolicy,
  now: Date,
): ResendDecision {
  if (isExpired(snapshot, now)) return { kind: 'NOT_ACTIVE', expire: true };
  if (snapshot.state !== 'PENDING' || snapshot.resendCount >= snapshot.maxResends) {
    return { kind: 'NOT_ACTIVE', expire: false };
  }
  const availableAt = snapshot.lastSentAt.getTime() + policy.resendCooldownSeconds * 1_000;
  if (now.getTime() < availableAt) {
    return {
      kind: 'COOLDOWN',
      retryAfterSeconds: Math.ceil((availableAt - now.getTime()) / 1_000),
    };
  }
  return {
    kind: 'ALLOWED',
    resendAvailableAt: new Date(now.getTime() + policy.resendCooldownSeconds * 1_000),
  };
}

export type VerifyDecision =
  | { readonly kind: 'NOT_ACTIVE'; readonly expire: boolean }
  | { readonly kind: 'VERIFIED' }
  | { readonly kind: 'FAILED'; readonly exhausts: boolean };

/**
 * Decides one verification attempt. A correct code verifies only while PENDING, unexpired, and
 * inside the attempt budget; a wrong code consumes one attempt and exhausts at the cap.
 */
export function decideVerify(
  snapshot: ChallengeSnapshot,
  now: Date,
  codeMatches: boolean,
): VerifyDecision {
  if (isExpired(snapshot, now)) return { kind: 'NOT_ACTIVE', expire: true };
  if (snapshot.state !== 'PENDING' || snapshot.failedAttempts >= snapshot.maxFailedAttempts) {
    return { kind: 'NOT_ACTIVE', expire: false };
  }
  if (codeMatches) return { kind: 'VERIFIED' };
  return { kind: 'FAILED', exhausts: snapshot.failedAttempts + 1 >= snapshot.maxFailedAttempts };
}
