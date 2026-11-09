import type { AssuranceLevel, AuthFactor, SessionPolicy } from '../../contracts/session';

/** SPEC-002 design §2.1 bounds for `SessionPolicy` (PLAN §9.2 defaults live in configuration). */
export const SESSION_POLICY_BOUNDS = Object.freeze({
  accessTokenSeconds: [300, 900],
  idleSeconds: [86_400, 5_184_000],
  absoluteSeconds: [86_400, 15_552_000],
  rotationGraceSeconds: [0, 60],
  recentAuthSeconds: [60, 900],
} as const satisfies Record<keyof SessionPolicy, readonly [number, number]>);

export class SessionPolicyError extends Error {
  constructor() {
    super('SESSION_POLICY_INVALID');
    this.name = 'SessionPolicyError';
  }
}

/** Fails closed on any value outside its bound, or an absolute lifetime shorter than idle. */
export function validateSessionPolicy(policy: SessionPolicy): SessionPolicy {
  for (const [field, [minimum, maximum]] of Object.entries(SESSION_POLICY_BOUNDS)) {
    const value = policy[field as keyof SessionPolicy];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new SessionPolicyError();
    }
  }
  if (policy.absoluteSeconds < policy.idleSeconds) throw new SessionPolicyError();
  return Object.freeze({ ...policy });
}

export const AUTH_FACTORS: readonly AuthFactor[] = Object.freeze([
  'CONTACT_OTP',
  'PASSWORD',
  'IDENTITY_REVERIFICATION',
]);

/** PLAN §10: contact proof plus password is AAL2; anything less is AAL1. */
export function assuranceFor(factors: readonly AuthFactor[]): AssuranceLevel {
  return factors.includes('CONTACT_OTP') && factors.includes('PASSWORD') ? 'AAL2' : 'AAL1';
}

/** Returns the distinct factors in canonical order, or undefined when the set is empty or invalid. */
export function canonicalFactors(factors: readonly unknown[]): readonly AuthFactor[] | undefined {
  if (factors.length === 0) return undefined;
  if (factors.some((factor) => !AUTH_FACTORS.includes(factor as AuthFactor))) return undefined;
  return AUTH_FACTORS.filter((factor) => factors.includes(factor));
}

/** The family's usable lifetime ends at the earlier of idle and absolute expiry. */
export function familyExpiry(idleExpiresAt: Date, absoluteExpiresAt: Date): Date {
  return idleExpiresAt.getTime() <= absoluteExpiresAt.getTime() ? idleExpiresAt : absoluteExpiresAt;
}
