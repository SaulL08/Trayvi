import { describe, expect, it } from 'vitest';

import type { ChallengePolicy, ChallengeState } from '../../src/contracts/challenge';
import {
  canTransition,
  ChallengePolicyError,
  decideResend,
  decideVerify,
  isExpired,
  isProofExpired,
  newChallengeTimes,
  proofExpiry,
  validateChallengePolicy,
  type ChallengeSnapshot,
} from '../../src/domain/challenge/challenge-lifecycle';

const policy: ChallengePolicy = {
  codeLifetimeSeconds: 300,
  maxFailedAttempts: 5,
  maxResends: 3,
  resendCooldownSeconds: 30,
  proofLifetimeSeconds: 600,
};
const start = new Date('2026-11-03T12:00:00.000Z');
const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1_000);

function snapshot(overrides: Partial<ChallengeSnapshot> = {}): ChallengeSnapshot {
  return {
    state: 'PENDING',
    failedAttempts: 0,
    maxFailedAttempts: policy.maxFailedAttempts,
    resendCount: 0,
    maxResends: policy.maxResends,
    lastSentAt: start,
    expiresAt: newChallengeTimes(policy, start).expiresAt,
    ...overrides,
  };
}

const states: readonly ChallengeState[] = [
  'PENDING',
  'VERIFIED',
  'CONSUMED',
  'EXPIRED',
  'EXHAUSTED',
  'CANCELLED',
];

describe('challenge lifecycle (PLAN §5.3)', () => {
  it('allows exactly the PLAN edges in the full 6 x 6 matrix', () => {
    const allowed = new Set([
      'PENDING->VERIFIED',
      'PENDING->EXHAUSTED',
      'PENDING->EXPIRED',
      'PENDING->CANCELLED',
      'VERIFIED->CONSUMED',
      'VERIFIED->EXPIRED',
    ]);
    for (const from of states) {
      for (const to of states) {
        expect(canTransition(from, to), `${from}->${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it('derives code, resend, and proof times from the policy', () => {
    expect(newChallengeTimes(policy, start)).toEqual({
      expiresAt: at(300),
      resendAvailableAt: at(30),
    });
    expect(proofExpiry(policy, start)).toEqual(at(600));
    expect(isProofExpired(at(600), at(599))).toBe(false);
    expect(isProofExpired(at(600), at(600))).toBe(true);
  });

  it('expires a PENDING challenge exactly at its code lifetime and never a terminal one', () => {
    expect(isExpired(snapshot(), at(299))).toBe(false);
    expect(isExpired(snapshot(), at(300))).toBe(true);
    for (const state of states.filter((entry) => entry !== 'PENDING')) {
      expect(isExpired(snapshot({ state }), at(10_000))).toBe(false);
    }
  });

  it('verifies a correct code, counts wrong codes, and exhausts at the cap', () => {
    expect(decideVerify(snapshot(), at(10), true)).toEqual({ kind: 'VERIFIED' });
    expect(decideVerify(snapshot({ failedAttempts: 3 }), at(10), false)).toEqual({
      kind: 'FAILED',
      exhausts: false,
    });
    expect(decideVerify(snapshot({ failedAttempts: 4 }), at(10), false)).toEqual({
      kind: 'FAILED',
      exhausts: true,
    });
    // A correct code after the cap, after expiry, or outside PENDING never verifies.
    expect(decideVerify(snapshot({ failedAttempts: 5 }), at(10), true)).toEqual({
      kind: 'NOT_ACTIVE',
      expire: false,
    });
    expect(decideVerify(snapshot(), at(300), true)).toEqual({ kind: 'NOT_ACTIVE', expire: true });
    for (const state of states.filter((entry) => entry !== 'PENDING')) {
      expect(decideVerify(snapshot({ state }), at(10), true)).toEqual({
        kind: 'NOT_ACTIVE',
        expire: false,
      });
    }
  });

  it('enforces the resend cooldown, the resend count, and expiry', () => {
    expect(decideResend(snapshot(), policy, at(29))).toEqual({
      kind: 'COOLDOWN',
      retryAfterSeconds: 1,
    });
    expect(decideResend(snapshot(), policy, at(1))).toEqual({
      kind: 'COOLDOWN',
      retryAfterSeconds: 29,
    });
    expect(decideResend(snapshot(), policy, at(30))).toEqual({
      kind: 'ALLOWED',
      resendAvailableAt: at(60),
    });
    expect(decideResend(snapshot({ resendCount: 3 }), policy, at(60))).toEqual({
      kind: 'NOT_ACTIVE',
      expire: false,
    });
    expect(decideResend(snapshot({ lastSentAt: at(200) }), policy, at(300))).toEqual({
      kind: 'NOT_ACTIVE',
      expire: true,
    });
    expect(decideResend(snapshot({ state: 'VERIFIED' }), policy, at(60))).toEqual({
      kind: 'NOT_ACTIVE',
      expire: false,
    });
  });

  it('validates every policy bound from PLAN §8.2', () => {
    expect(validateChallengePolicy(policy)).toEqual(policy);
    const invalid: readonly Partial<ChallengePolicy>[] = [
      { codeLifetimeSeconds: 119 },
      { codeLifetimeSeconds: 601 },
      { maxFailedAttempts: 2 },
      { maxFailedAttempts: 11 },
      { maxResends: -1 },
      { maxResends: 6 },
      { resendCooldownSeconds: 14 },
      { resendCooldownSeconds: 121 },
      { proofLifetimeSeconds: 119 },
      { proofLifetimeSeconds: 901 },
      { codeLifetimeSeconds: 300.5 },
    ];
    for (const change of invalid) {
      expect(() => validateChallengePolicy({ ...policy, ...change })).toThrow(ChallengePolicyError);
    }
  });
});
