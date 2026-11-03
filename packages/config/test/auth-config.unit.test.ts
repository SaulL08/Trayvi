import { describe, expect, it } from 'vitest';

import { ConfigValidationError, parseAuthConfig } from '../src';
import type { RawEnvironment } from '../src';

const secretHex = 'a1'.repeat(32);

function issuesOf(environment: RawEnvironment, runtime: 'test' | 'production' = 'test') {
  try {
    parseAuthConfig(environment, runtime);
    return [];
  } catch (error: unknown) {
    if (!(error instanceof ConfigValidationError)) throw error;
    return error.issues;
  }
}

describe('Auth configuration', () => {
  it('applies the PLAN defaults for numbering, challenges, and rate limits', () => {
    const config = parseAuthConfig({}, 'test');
    expect(config.numbering).toEqual({
      defaultCallingCode: '1',
      callingCodes: [
        { code: '1', nationalNumberLength: 10, destinationCodes: ['809', '829', '849'] },
      ],
    });
    expect(config.challenge).toEqual({
      codeLifetimeSeconds: 300,
      maxFailedAttempts: 5,
      maxResends: 3,
      resendCooldownSeconds: 30,
      proofLifetimeSeconds: 600,
    });
    const rule = (dimension: string) =>
      config.rateLimits.find((entry) => entry.dimension === dimension);
    expect(rule('CHALLENGE_START_CONTACT_HOUR')).toMatchObject({ limit: 5, windowSeconds: 3_600 });
    expect(rule('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY')).toMatchObject({
      limit: 10,
      windowSeconds: 86_400,
    });
    expect(rule('REGISTRATION_START_CONTACT_30D')).toMatchObject({ limit: 3 });
    expect(config.rateLimits).toHaveLength(13);
    expect(config.delivery).toEqual({ timeoutMs: 3_000, budgetPerMinute: 60 });
    expect(config.callbacks.providers).toEqual([]);
    expect(Object.isFrozen(config.challenge)).toBe(true);
  });

  it('supports configuration B (no default calling code) and a second market', () => {
    const config = parseAuthConfig(
      {
        AUTH_PHONE_DEFAULT_CALLING_CODE: 'none',
        AUTH_PHONE_CALLING_CODES: '1:10:809,829,849;34:9',
      },
      'test',
    );
    expect(config.numbering.defaultCallingCode).toBeUndefined();
    expect(config.numbering.callingCodes[1]).toEqual({ code: '34', nationalNumberLength: 9 });
  });

  it('rejects challenge policy values outside the PLAN §8.2 bounds', () => {
    const issues = issuesOf({
      AUTH_OTP_CODE_LIFETIME_SECONDS: '60',
      AUTH_OTP_MAX_FAILED_ATTEMPTS: '11',
      AUTH_OTP_MAX_RESENDS: '-1',
      AUTH_OTP_RESEND_COOLDOWN_SECONDS: '121',
      AUTH_CONTACT_PROOF_LIFETIME_SECONDS: '1e3',
    });
    expect(issues.map((issue) => issue.field)).toEqual([
      'AUTH_OTP_CODE_LIFETIME_SECONDS',
      'AUTH_OTP_MAX_FAILED_ATTEMPTS',
      'AUTH_OTP_MAX_RESENDS',
      'AUTH_OTP_RESEND_COOLDOWN_SECONDS',
      'AUTH_CONTACT_PROOF_LIFETIME_SECONDS',
    ]);
  });

  it('rejects malformed numbering policies', () => {
    expect(issuesOf({ AUTH_PHONE_CALLING_CODES: '1:10;1:10' })[0]?.field).toBe(
      'AUTH_PHONE_CALLING_CODES',
    );
    expect(issuesOf({ AUTH_PHONE_CALLING_CODES: 'one' })[0]?.field).toBe(
      'AUTH_PHONE_CALLING_CODES',
    );
    expect(issuesOf({ AUTH_PHONE_DEFAULT_CALLING_CODE: '44' })[0]?.field).toBe(
      'AUTH_PHONE_DEFAULT_CALLING_CODE',
    );
  });

  it('loads callback provider secrets without echoing them in validation errors', () => {
    const config = parseAuthConfig(
      { AUTH_CALLBACK_PROVIDERS: 'synthetic', AUTH_CALLBACK_SECRET_SYNTHETIC: secretHex },
      'test',
    );
    expect(config.callbacks.providers[0]?.alias).toBe('synthetic');
    expect(config.callbacks.providers[0]?.secret.toString('hex')).toBe(secretHex);

    const issues = issuesOf({
      AUTH_CALLBACK_PROVIDERS: 'synthetic',
      AUTH_CALLBACK_SECRET_SYNTHETIC: 'short-secret-value',
    });
    expect(issues).toEqual([
      {
        field: 'AUTH_CALLBACK_SECRET_SYNTHETIC',
        constraint: 'must be 32 to 64 random bytes in hexadecimal',
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain('short-secret-value');
  });

  it('forbids synthetic keys and the synthetic provider in production', () => {
    const fields = issuesOf(
      { AUTH_CALLBACK_PROVIDERS: 'synthetic', AUTH_CALLBACK_SECRET_SYNTHETIC: secretHex },
      'production',
    ).map((issue) => issue.field);
    expect([...fields].sort()).toEqual(['AUTH_CALLBACK_PROVIDERS', 'AUTH_KEY_SOURCE']);
    expect(issuesOf({ AUTH_KEY_SOURCE: 'kms' }).map((issue) => issue.field)).toEqual([
      'AUTH_KEY_SOURCE',
    ]);
  });
});
