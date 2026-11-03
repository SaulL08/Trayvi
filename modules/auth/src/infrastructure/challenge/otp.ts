import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ChallengePurpose } from '../../contracts/challenge';
import { AuthKeyError, type AuthKeyring } from '../../contracts/keys';
import type { RandomSource } from '../../contracts/runtime';

export const OTP_COMMITMENT_DOMAIN = 'trayvi.auth-otp-commitment';
export const OTP_COMMITMENT_VERSION = 'otp-v1';
const CODE_SPACE = 1_000_000;
const UINT32_SPACE = 2 ** 32;
// Largest multiple of 10^6 not above 2^32; values at or above it are rejected, never folded.
const REJECTION_LIMIT = Math.floor(UINT32_SPACE / CODE_SPACE) * CODE_SPACE;
const MAX_DRAWS = 64;
const CODE_FORMAT = /^[0-9]{6}$/u;

const nodeRandom: RandomSource = { bytes: (length) => randomBytes(length) };

/** PLAN §8.1: 6 ASCII digits, uniform over 000000-999999 by rejection sampling. */
export class RejectionSamplingOtpGenerator {
  readonly #random: RandomSource;

  constructor(random: RandomSource = nodeRandom) {
    this.#random = random;
  }

  generate(): string {
    for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
      const bytes = this.#random.bytes(4);
      if (bytes.byteLength !== 4) throw new Error('OTP_ENTROPY_UNAVAILABLE');
      const value = bytes.readUInt32BE(0);
      if (value < REJECTION_LIMIT) return String(value % CODE_SPACE).padStart(6, '0');
    }
    // Probability of 64 consecutive rejections is below 2^-500 for a working CSPRNG.
    throw new Error('OTP_ENTROPY_UNAVAILABLE');
  }
}

export function isOtpCodeFormat(code: unknown): code is string {
  return typeof code === 'string' && CODE_FORMAT.test(code);
}

/** PLAN §8.1 commitment: HMAC-SHA-256 over NUL-joined domain, version, challenge ID, purpose, code. */
export function computeOtpCommitment(
  key: Buffer,
  challengeId: string,
  purpose: ChallengePurpose,
  code: string,
): Buffer {
  return createHmac('sha256', key)
    .update(
      [OTP_COMMITMENT_DOMAIN, OTP_COMMITMENT_VERSION, challengeId, purpose, code].join('\0'),
      'utf8',
    )
    .digest();
}

export function otpCommitmentsEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);
}

/** Commits and checks codes under the Auth OTP commitment keyring. */
export class KeyedOtpCommitter {
  readonly #keyring: AuthKeyring;

  constructor(keyring: AuthKeyring) {
    this.#keyring = keyring;
  }

  commit(
    challengeId: string,
    purpose: ChallengePurpose,
    code: string,
  ): { readonly commitment: Buffer; readonly keyVersion: string } {
    if (!isOtpCodeFormat(code)) throw new Error('OTP_CODE_INVALID');
    const key = this.#keyring.primary('auth-otp-commitment');
    return {
      commitment: computeOtpCommitment(key.material, challengeId, purpose, code),
      keyVersion: key.version,
    };
  }

  /** Recomputes under the stored key version and compares in constant time. */
  matches(
    challengeId: string,
    purpose: ChallengePurpose,
    candidate: unknown,
    stored: { readonly commitment: Buffer; readonly keyVersion: string },
  ): boolean {
    const key = this.#keyring
      .active('auth-otp-commitment')
      .find((entry) => entry.version === stored.keyVersion);
    if (!key) throw new AuthKeyError('KEY_UNAVAILABLE');
    // A malformed candidate is still compared against a commitment so the work stays constant.
    const code = isOtpCodeFormat(candidate) ? candidate : '------';
    const expected = computeOtpCommitment(key.material, challengeId, purpose, code);
    return otpCommitmentsEqual(expected, stored.commitment) && isOtpCodeFormat(candidate);
  }
}
