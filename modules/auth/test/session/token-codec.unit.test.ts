import { describe, expect, it } from 'vitest';

import {
  assuranceFor,
  canonicalFactors,
  familyExpiry,
  SessionPolicyError,
  validateSessionPolicy,
} from '../../src/domain/session/session-policy';
import { NodeOpaqueTokenCodec } from '../../src/infrastructure/shared/opaque-token-codec';

const vectorBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => 0xa0 + index));

describe('session tokens (R-01, PLAN §9.1)', () => {
  it('reproduces the refresh-token vector and stores only the SHA-256 hash', () => {
    const codec = new NodeOpaqueTokenCodec({ bytes: () => Buffer.from(vectorBytes) });
    const issued = codec.issue('tvr_');
    expect(issued.token).toBe('tvr_oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8');
    expect(issued.hash.toString('hex')).toBe(
      'c6aab7bdc67b337b613418b31f3f0eb5b91669970a9360654d032b3070ffdc95',
    );
    expect(issued.hash.byteLength).toBe(32);
  });

  it('issues tva_ access and tvr_ refresh tokens from 32 random bytes', () => {
    const codec = new NodeOpaqueTokenCodec();
    const access = codec.issue('tva_');
    const refresh = codec.issue('tvr_');
    expect(access.token).toMatch(/^tva_[A-Za-z0-9_-]{43}$/u);
    expect(refresh.token).toMatch(/^tvr_[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(access.token.slice(4), 'base64url')).toHaveLength(32);
    expect(codec.hash('tva_', access.token)?.equals(access.hash)).toBe(true);
  });

  it('never accepts a token under the other prefix or a malformed value', () => {
    const codec = new NodeOpaqueTokenCodec();
    const access = codec.issue('tva_').token;
    const refresh = codec.issue('tvr_').token;
    expect(codec.hash('tvr_', access)).toBeUndefined();
    expect(codec.hash('tva_', refresh)).toBeUndefined();
    for (const candidate of [undefined, null, 0, [], `Bearer ${access}`, access.toUpperCase()]) {
      expect(codec.hash('tva_', candidate)).toBeUndefined();
    }
  });
});

describe('session policy and assurance', () => {
  const policy = {
    accessTokenSeconds: 600,
    idleSeconds: 2_592_000,
    absoluteSeconds: 7_776_000,
    rotationGraceSeconds: 30,
    recentAuthSeconds: 300,
  };

  it('accepts the PLAN §9.2 defaults and rejects every out-of-bound field', () => {
    expect(validateSessionPolicy(policy)).toEqual(policy);
    for (const change of [
      { accessTokenSeconds: 299 },
      { accessTokenSeconds: 901 },
      { idleSeconds: 86_399 },
      { absoluteSeconds: 15_552_001 },
      { rotationGraceSeconds: 61 },
      { recentAuthSeconds: 59 },
      { accessTokenSeconds: 600.5 },
      { idleSeconds: 2_592_000, absoluteSeconds: 2_591_999 },
    ]) {
      expect(() => validateSessionPolicy({ ...policy, ...change })).toThrow(SessionPolicyError);
    }
  });

  it('grants AAL2 only for a contact proof plus a password', () => {
    expect(assuranceFor(['CONTACT_OTP'])).toBe('AAL1');
    expect(assuranceFor(['PASSWORD'])).toBe('AAL1');
    expect(assuranceFor(['CONTACT_OTP', 'IDENTITY_REVERIFICATION'])).toBe('AAL1');
    expect(assuranceFor(['PASSWORD', 'CONTACT_OTP'])).toBe('AAL2');
  });

  it('canonicalizes factor sets and rejects empty or unknown ones', () => {
    expect(canonicalFactors(['PASSWORD', 'CONTACT_OTP', 'PASSWORD'])).toEqual([
      'CONTACT_OTP',
      'PASSWORD',
    ]);
    expect(canonicalFactors([])).toBeUndefined();
    expect(canonicalFactors(['CONTACT_OTP', 'SMS'])).toBeUndefined();
  });

  it('ends a family at the earlier of idle and absolute expiry', () => {
    const idle = new Date('2026-12-01T00:00:00Z');
    const absolute = new Date('2026-11-20T00:00:00Z');
    expect(familyExpiry(idle, absolute)).toBe(absolute);
    expect(familyExpiry(absolute, idle)).toBe(absolute);
  });
});
