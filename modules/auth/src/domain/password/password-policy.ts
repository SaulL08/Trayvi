import type { PasswordPolicy } from '../../contracts/password';

/** PLAN §10: 12-128 characters after NFC, no composition rules. */
export const PASSWORD_POLICY: PasswordPolicy = Object.freeze({ minLength: 12, maxLength: 128 });

export type PasswordNormalization =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'TOO_SHORT' | 'TOO_LONG' };

/**
 * NFC-normalizes and length-checks a password. Length counts Unicode code points, so one accented
 * letter counts once whether it arrived precomposed or decomposed. Non-strings fail as TOO_SHORT.
 */
export function normalizePassword(input: unknown): PasswordNormalization {
  if (typeof input !== 'string') return { ok: false, reason: 'TOO_SHORT' };
  const value = input.normalize('NFC');
  const length = [...value].length;
  if (length < PASSWORD_POLICY.minLength) return { ok: false, reason: 'TOO_SHORT' };
  if (length > PASSWORD_POLICY.maxLength) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, value };
}

export interface ScryptParameters {
  readonly cost: number; // N
  readonly blockSize: number; // r
  readonly parallelization: number; // p
  readonly keyLength: number;
  readonly saltLength: number;
}

/** PLAN §10 `scrypt-v1`: N = 2^17, r = 8, p = 1, 16-byte salt, 32-byte output. */
export const SCRYPT_V1: ScryptParameters = Object.freeze({
  cost: 2 ** 17,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
  saltLength: 16,
});

export const CURRENT_PASSWORD_PARAMETERS = 'scrypt-v1';

export const PASSWORD_PARAMETER_VERSIONS: Readonly<Record<string, ScryptParameters>> =
  Object.freeze({
    'scrypt-v1': SCRYPT_V1,
  });
