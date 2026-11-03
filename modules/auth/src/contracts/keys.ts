export type AuthKeyPurpose =
  | 'auth-contact-fingerprint'
  | 'auth-contact-kek'
  | 'auth-otp-commitment'
  | 'auth-subject-commitment';

export const AUTH_KEY_PURPOSES: readonly AuthKeyPurpose[] = [
  'auth-contact-fingerprint',
  'auth-contact-kek',
  'auth-otp-commitment',
  'auth-subject-commitment',
];

export const AUTH_KEY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface VersionedKey {
  readonly purpose: AuthKeyPurpose;
  readonly version: string; // ^[a-z0-9][a-z0-9._-]{0,63}$
  readonly state: 'PRIMARY' | 'LOOKUP_ACTIVE' | 'RETIRED';
  readonly material: Buffer; // 32 bytes; never logged or serialized
}

export interface AuthKeyring {
  /** Primary first, then lookup-active versions in ascending version order. Throws AuthKeyError if none. */
  active(purpose: AuthKeyPurpose): readonly VersionedKey[];
  primary(purpose: AuthKeyPurpose): VersionedKey;
}

export type AuthKeyErrorCode = 'KEY_UNAVAILABLE' | 'KEY_PURPOSE_COLLISION' | 'KEY_INVALID';

export class AuthKeyError extends Error {
  readonly code: AuthKeyErrorCode;

  constructor(code: AuthKeyErrorCode) {
    // The message carries only the code: never a purpose's key bytes or version material.
    super(code);
    this.name = 'AuthKeyError';
    this.code = code;
  }
}
