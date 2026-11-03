import { describe, expect, it } from 'vitest';

import { NodeOpaqueTokenCodec } from '../../src/infrastructure/shared/opaque-token-codec';

const vectorBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => 0xa0 + index));
const vectorToken = 'tvr_oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8';
const vectorHash = 'c6aab7bdc67b337b613418b31f3f0eb5b91669970a9360654d032b3070ffdc95';

describe('NodeOpaqueTokenCodec', () => {
  it('reproduces the PLAN §9.1 refresh-token vector', () => {
    const codec = new NodeOpaqueTokenCodec({ bytes: () => Buffer.from(vectorBytes) });
    const issued = codec.issue('tvr_');
    expect(issued.token).toBe(vectorToken);
    expect(issued.hash.toString('hex')).toBe(vectorHash);
    expect(codec.hash('tvr_', vectorToken)?.toString('hex')).toBe(vectorHash);
  });

  it('issues distinct 256-bit tokens with the requested prefix', () => {
    const codec = new NodeOpaqueTokenCodec();
    const tokens = new Set(Array.from({ length: 100 }, () => codec.issue('tvp_').token));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^tvp_[A-Za-z0-9_-]{43}$/u);
  });

  it('returns undefined for every malformed candidate without throwing', () => {
    const codec = new NodeOpaqueTokenCodec();
    const candidates: unknown[] = [
      undefined,
      null,
      42,
      {},
      '',
      vectorToken.slice(4),
      `tva_${vectorToken.slice(4)}`,
      `${vectorToken}A`,
      vectorToken.slice(0, -1),
      `${vectorToken.slice(0, -1)}+`,
      // Same bytes, non-canonical final character (trailing bits set).
      `${vectorToken.slice(0, -1)}9`,
      ` ${vectorToken}`,
    ];
    for (const candidate of candidates) expect(codec.hash('tvr_', candidate)).toBeUndefined();
  });

  it('refuses an entropy source that returns the wrong length', () => {
    const codec = new NodeOpaqueTokenCodec({ bytes: () => Buffer.alloc(16) });
    expect(() => codec.issue('tva_')).toThrow('TOKEN_ENTROPY_UNAVAILABLE');
  });
});
