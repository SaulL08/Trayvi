import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';
import {
  computeOtpCommitment,
  KeyedOtpCommitter,
  otpCommitmentsEqual,
  RejectionSamplingOtpGenerator,
} from '../../src/infrastructure/challenge/otp';

const vectorKey = Buffer.from(
  '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f',
  'hex',
);
const challengeId = '018f0000-0000-7000-8000-0000000000a1';

function keyring(
  otpKeys: readonly {
    version: string;
    state: 'PRIMARY' | 'LOOKUP_ACTIVE' | 'RETIRED';
    fill: number;
  }[],
) {
  return new ConfiguredAuthKeyring([
    {
      purpose: 'auth-contact-fingerprint',
      version: 'v1',
      state: 'PRIMARY',
      material: Buffer.alloc(32, 1),
    },
    { purpose: 'auth-contact-kek', version: 'v1', state: 'PRIMARY', material: Buffer.alloc(32, 2) },
    {
      purpose: 'auth-subject-commitment',
      version: 'v1',
      state: 'PRIMARY',
      material: Buffer.alloc(32, 3),
    },
    ...otpKeys.map((key) => ({
      purpose: 'auth-otp-commitment' as const,
      version: key.version,
      state: key.state,
      material: key.fill === 0x60 ? vectorKey : Buffer.alloc(32, key.fill),
    })),
  ]);
}

describe('OTP commitment (PLAN §8.1)', () => {
  it('reproduces the synthetic vector', () => {
    expect(
      computeOtpCommitment(vectorKey, challengeId, 'CONTACT_PROOF', '042817').toString('hex'),
    ).toBe('9c765af2d9a4d0e3db10e11191e28b3dd71b8cc58a7759c13f9f10a4d7c508f1');
  });

  it('binds the commitment to the challenge, purpose, code, and key', () => {
    const baseline = computeOtpCommitment(vectorKey, challengeId, 'CONTACT_PROOF', '042817');
    const variants = [
      computeOtpCommitment(
        vectorKey,
        '018f0000-0000-7000-8000-0000000000a2',
        'CONTACT_PROOF',
        '042817',
      ),
      computeOtpCommitment(vectorKey, challengeId, 'STEP_UP', '042817'),
      computeOtpCommitment(vectorKey, challengeId, 'CONTACT_PROOF', '042818'),
      computeOtpCommitment(Buffer.alloc(32, 9), challengeId, 'CONTACT_PROOF', '042817'),
    ];
    for (const variant of variants) expect(otpCommitmentsEqual(variant, baseline)).toBe(false);
  });

  it('verifies under the stored key version, rejects malformed codes, and fails closed on a retired key', () => {
    const current = new KeyedOtpCommitter(
      keyring([{ version: 'otp-v1', state: 'PRIMARY', fill: 0x60 }]),
    );
    const stored = current.commit(challengeId, 'CONTACT_PROOF', '042817');
    expect(stored.keyVersion).toBe('otp-v1');
    expect(current.matches(challengeId, 'CONTACT_PROOF', '042817', stored)).toBe(true);
    for (const candidate of [
      '042818',
      '42817',
      '0428170',
      ' 042817',
      42817,
      undefined,
      '０４２８１７',
    ]) {
      expect(current.matches(challengeId, 'CONTACT_PROOF', candidate, stored)).toBe(false);
    }
    const rotated = new KeyedOtpCommitter(
      keyring([
        { version: 'otp-v2', state: 'PRIMARY', fill: 0x70 },
        { version: 'otp-v1', state: 'LOOKUP_ACTIVE', fill: 0x60 },
      ]),
    );
    expect(rotated.matches(challengeId, 'CONTACT_PROOF', '042817', stored)).toBe(true);
    const retired = new KeyedOtpCommitter(
      keyring([
        { version: 'otp-v2', state: 'PRIMARY', fill: 0x70 },
        { version: 'otp-v1', state: 'RETIRED', fill: 0x60 },
      ]),
    );
    expect(() => retired.matches(challengeId, 'CONTACT_PROOF', '042817', stored)).toThrow(
      'KEY_UNAVAILABLE',
    );
  });

  it('compares commitments only through a constant-time, length-checked comparison', () => {
    const commitment = computeOtpCommitment(vectorKey, challengeId, 'CONTACT_PROOF', '042817');
    expect(otpCommitmentsEqual(commitment, Buffer.from(commitment))).toBe(true);
    expect(otpCommitmentsEqual(commitment, commitment.subarray(0, 31))).toBe(false);
    expect(otpCommitmentsEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe('OTP generation (PLAN §8.1)', () => {
  it('rejects draws in the biased tail instead of folding them', () => {
    const draws = [
      Buffer.from('ffffffff', 'hex'), // 4294967295 >= 4294000000: rejected
      Buffer.from('fff13d80', 'hex'), // exactly 4294000000, the first rejected value
      Buffer.from('00000001', 'hex'), // accepted -> 000001
    ];
    const generator = new RejectionSamplingOtpGenerator({
      bytes: () => draws.shift() ?? Buffer.alloc(4),
    });
    expect(generator.generate()).toBe('000001');
    expect(draws).toHaveLength(0);
  });

  it('accepts the largest unbiased draw and fails closed on a broken entropy source', () => {
    const largest = Buffer.alloc(4);
    largest.writeUInt32BE(4_293_999_999);
    expect(
      new RejectionSamplingOtpGenerator({ bytes: () => Buffer.from(largest) }).generate(),
    ).toBe('999999');
    expect(() =>
      new RejectionSamplingOtpGenerator({ bytes: () => Buffer.alloc(2) }).generate(),
    ).toThrow('OTP_ENTROPY_UNAVAILABLE');
    expect(() =>
      new RejectionSamplingOtpGenerator({ bytes: () => Buffer.from('ffffffff', 'hex') }).generate(),
    ).toThrow('OTP_ENTROPY_UNAVAILABLE');
  });

  it('produces 6 ASCII digits uniformly over 10^6 codes (chi-squared)', () => {
    // Pre-drawn CSPRNG bytes keep the run fast; the generator still applies rejection sampling.
    const pool = randomBytes(4 * 1_100_000);
    let offset = 0;
    const generator = new RejectionSamplingOtpGenerator({
      bytes: (length) => {
        const slice = pool.subarray(offset, offset + length);
        offset += length;
        return slice.byteLength === length ? slice : randomBytes(length);
      },
    });
    const samples = 1_000_000;
    const prefixBuckets = new Array<number>(1_000).fill(0);
    const digitBuckets = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
    for (let index = 0; index < samples; index += 1) {
      const code = generator.generate();
      if (!/^[0-9]{6}$/u.test(code)) throw new Error(`malformed code at ${index}`);
      prefixBuckets[Number(code.slice(0, 3))] = (prefixBuckets[Number(code.slice(0, 3))] ?? 0) + 1;
      for (let position = 0; position < 6; position += 1) {
        const bucket = digitBuckets[position];
        if (bucket) bucket[Number(code[position])] = (bucket[Number(code[position])] ?? 0) + 1;
      }
    }
    const chiSquared = (buckets: readonly number[]): number => {
      const expected = samples / buckets.length;
      return buckets.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    };
    // Critical values at p = 1e-6 keep this deterministic in practice:
    // df = 999 -> ~1211 (bound 1250); df = 9 -> ~44.6 (bound 46).
    expect(chiSquared(prefixBuckets)).toBeLessThan(1_250);
    for (const bucket of digitBuckets) expect(chiSquared(bucket)).toBeLessThan(46);
  }, 60_000);
});
