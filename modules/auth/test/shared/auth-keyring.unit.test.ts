import { describe, expect, it } from 'vitest';

import { AuthKeyError, type AuthKeyPurpose, type VersionedKey } from '../../src/contracts/keys';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';

const purposes: readonly AuthKeyPurpose[] = [
  'auth-contact-fingerprint',
  'auth-contact-kek',
  'auth-otp-commitment',
  'auth-subject-commitment',
];

function key(
  purpose: AuthKeyPurpose,
  fill: number,
  version = 'v1',
  state: VersionedKey['state'] = 'PRIMARY',
): VersionedKey {
  return { purpose, version, state, material: Buffer.alloc(32, fill) };
}

const baseline = purposes.map((purpose, index) => key(purpose, index + 1));

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return error instanceof AuthKeyError ? error.code : 'UNEXPECTED';
  }
}

describe('ConfiguredAuthKeyring', () => {
  it('orders the primary first, then lookup-active versions ascending, and drops retired keys', () => {
    const keyring = new ConfiguredAuthKeyring([
      ...baseline,
      key('auth-contact-fingerprint', 20, 'v3', 'LOOKUP_ACTIVE'),
      key('auth-contact-fingerprint', 21, 'v0', 'LOOKUP_ACTIVE'),
      key('auth-contact-fingerprint', 22, 'v9', 'RETIRED'),
    ]);
    expect(keyring.active('auth-contact-fingerprint').map((entry) => entry.version)).toEqual([
      'v1',
      'v0',
      'v3',
    ]);
    expect(keyring.primary('auth-otp-commitment').version).toBe('v1');
  });

  it('fails startup when two purposes share key bytes, without revealing a value', () => {
    let caught: unknown;
    try {
      new ConfiguredAuthKeyring([...baseline.slice(1), key('auth-contact-fingerprint', 2)]);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuthKeyError);
    expect((caught as AuthKeyError).code).toBe('KEY_PURPOSE_COLLISION');
    expect((caught as Error).message).toBe('KEY_PURPOSE_COLLISION');
    expect(JSON.stringify(caught)).not.toContain('0202');
  });

  it('fails startup when an Auth key reuses foreign (Identity) key material', () => {
    expect(
      codeOf(
        () => new ConfiguredAuthKeyring(baseline, { foreignKeyMaterial: [Buffer.alloc(32, 3)] }),
      ),
    ).toBe('KEY_PURPOSE_COLLISION');
  });

  it('rejects malformed, duplicated, or missing keys', () => {
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring([
            ...baseline.slice(1),
            { ...key('auth-contact-fingerprint', 9), material: Buffer.alloc(31) },
          ]),
      ),
    ).toBe('KEY_INVALID');
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring([
            ...baseline.slice(1),
            key('auth-contact-fingerprint', 9, 'V1'),
          ]),
      ),
    ).toBe('KEY_INVALID');
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring([
            ...baseline,
            key('auth-contact-kek', 30, 'v1', 'LOOKUP_ACTIVE'),
          ]),
      ),
    ).toBe('KEY_INVALID');
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring([
            ...baseline,
            key('auth-contact-kek', 2, 'v2', 'LOOKUP_ACTIVE'),
          ]),
      ),
    ).toBe('KEY_INVALID');
    expect(codeOf(() => new ConfiguredAuthKeyring(baseline.slice(1)))).toBe('KEY_UNAVAILABLE');
    expect(
      codeOf(() => new ConfiguredAuthKeyring([...baseline, key('auth-contact-kek', 31, 'v2')])),
    ).toBe('KEY_UNAVAILABLE');
  });

  it('copies key material so later caller mutation cannot change the keyring', () => {
    const material = Buffer.alloc(32, 40);
    const keyring = new ConfiguredAuthKeyring([
      { purpose: 'auth-contact-fingerprint', version: 'v1', state: 'PRIMARY', material },
      ...baseline.slice(1),
    ]);
    material.fill(0);
    expect(keyring.primary('auth-contact-fingerprint').material.equals(Buffer.alloc(32, 40))).toBe(
      true,
    );
    expect(JSON.stringify({ keyring })).toBe('{"keyring":"[AuthKeyring]"}');
  });
});
