import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_PASSWORD_PARAMETERS,
  normalizePassword,
  PASSWORD_PARAMETER_VERSIONS,
  SCRYPT_V1,
} from '../../src/domain/password/password-policy';
import { ListCompromisedPasswordChecker } from '../../src/infrastructure/password/compromised-password-checker';
import {
  PasswordHasherError,
  ScryptPasswordHasher,
  Semaphore,
} from '../../src/infrastructure/password/scrypt-password-hasher';

const CHEAP = { cost: 1_024, blockSize: 8, parallelization: 1, keyLength: 32, saltLength: 16 };

describe('scrypt-v1 password hashing (R-11, PLAN §10)', () => {
  it('uses exactly the PLAN §10 parameters', () => {
    expect(CURRENT_PASSWORD_PARAMETERS).toBe('scrypt-v1');
    expect(PASSWORD_PARAMETER_VERSIONS[CURRENT_PASSWORD_PARAMETERS]).toEqual({
      cost: 131_072,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
      saltLength: 16,
    });
  });

  it('reproduces the RFC 7914 scrypt vector through the same derivation', async () => {
    const hasher = new ScryptPasswordHasher({
      versions: {
        'scrypt-rfc7914': {
          cost: 16_384,
          blockSize: 8,
          parallelization: 1,
          keyLength: 64,
          saltLength: 14,
        },
      },
      current: 'scrypt-rfc7914',
      concurrency: 1,
    });
    const expected = Buffer.from(
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2' +
        'd5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
      'hex',
    );
    await expect(
      hasher.verify('pleaseletmein', {
        parameterVersion: 'scrypt-rfc7914',
        salt: Buffer.from('SodiumChloride', 'utf8'),
        hash: expected,
      }),
    ).resolves.toBe(true);
  });

  it('hashes with a fresh 16-byte salt into 32 bytes and verifies only the same password', async () => {
    const hasher = new ScryptPasswordHasher({
      versions: PASSWORD_PARAMETER_VERSIONS,
      current: 'scrypt-v1',
      concurrency: 2,
    });
    const [first, second] = await Promise.all([
      hasher.hash('correct horse battery'),
      hasher.hash('correct horse battery'),
    ]);
    expect(first.parameterVersion).toBe('scrypt-v1');
    expect(first.salt).toHaveLength(SCRYPT_V1.saltLength);
    expect(first.hash).toHaveLength(SCRYPT_V1.keyLength);
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.hash.equals(second.hash)).toBe(false);
    await expect(hasher.verify('correct horse battery', first)).resolves.toBe(true);
    await expect(hasher.verify('correct horse batterz', first)).resolves.toBe(false);
  }, 30_000);

  it('treats composed and decomposed forms of one password as equal (NFC)', async () => {
    const hasher = new ScryptPasswordHasher({
      versions: { 'scrypt-test': CHEAP },
      current: 'scrypt-test',
      concurrency: 1,
    });
    const stored = await hasher.hash('contraseña segura');
    await expect(hasher.verify('contraseña segura', stored)).resolves.toBe(true);
  });

  it('verifies unknown parameter versions or malformed hashes as a mismatch', async () => {
    const hasher = new ScryptPasswordHasher({
      versions: { 'scrypt-test': CHEAP },
      current: 'scrypt-test',
      concurrency: 1,
    });
    const stored = await hasher.hash('a long enough password');
    await expect(
      hasher.verify('a long enough password', { ...stored, parameterVersion: 'scrypt-v9' }),
    ).resolves.toBe(false);
    await expect(
      hasher.verify('a long enough password', { ...stored, hash: stored.hash.subarray(1) }),
    ).resolves.toBe(false);
  });

  it('asks for a rehash only for credentials under other parameters', () => {
    const hasher = new ScryptPasswordHasher({
      versions: { 'scrypt-v0': CHEAP, 'scrypt-v1': SCRYPT_V1 },
      current: 'scrypt-v1',
      concurrency: 1,
    });
    expect(hasher.needsRehash('scrypt-v1')).toBe(false);
    expect(hasher.needsRehash('scrypt-v0')).toBe(true);
  });

  it('caps concurrent work at the configured semaphore size', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const waiting: (() => void)[] = [];
    const tasks = Array.from({ length: 6 }, (_, index) =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => waiting.push(resolve));
        active -= 1;
        return index;
      }),
    );
    for (let released = 0; released < 6; released += 1) {
      while (waiting.length === 0) await new Promise((resolve) => setImmediate(resolve));
      expect(active).toBeLessThanOrEqual(2);
      waiting.shift()?.();
    }
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('refuses invalid hasher options and a short entropy source', async () => {
    expect(
      () => new ScryptPasswordHasher({ versions: {}, current: 'scrypt-v1', concurrency: 1 }),
    ).toThrow(PasswordHasherError);
    expect(
      () =>
        new ScryptPasswordHasher({
          versions: { 'scrypt-test': CHEAP },
          current: 'scrypt-test',
          concurrency: 0,
        }),
    ).toThrow(PasswordHasherError);
    const hasher = new ScryptPasswordHasher({
      versions: { 'scrypt-test': CHEAP },
      current: 'scrypt-test',
      concurrency: 1,
      random: { bytes: () => Buffer.alloc(8) },
    });
    await expect(hasher.hash('a long enough password')).rejects.toThrow(
      'PASSWORD_ENTROPY_UNAVAILABLE',
    );
  });
});

describe('password policy (R-12)', () => {
  it('accepts 12 to 128 code points after NFC', () => {
    expect(normalizePassword('a'.repeat(11))).toEqual({ ok: false, reason: 'TOO_SHORT' });
    expect(normalizePassword('a'.repeat(12))).toEqual({ ok: true, value: 'a'.repeat(12) });
    expect(normalizePassword('a'.repeat(128)).ok).toBe(true);
    expect(normalizePassword('a'.repeat(129))).toEqual({ ok: false, reason: 'TOO_LONG' });
    // Twelve emoji are twelve code points even though they are 24 UTF-16 units.
    expect(normalizePassword('🔐'.repeat(12)).ok).toBe(true);
    expect(normalizePassword('🔐'.repeat(11))).toEqual({ ok: false, reason: 'TOO_SHORT' });
    // Ten letters plus a decomposed ñ are 12 code points as sent but 11 after NFC composes the ñ.
    expect(normalizePassword(`${'a'.repeat(10)}n\u0303`)).toEqual({
      ok: false,
      reason: 'TOO_SHORT',
    });
    expect(normalizePassword(`${'a'.repeat(10)}n\u0303b`)).toEqual({
      ok: true,
      value: `${'a'.repeat(10)}\u00f1b`,
    });
  });

  it('rejects non-string input as too short', () => {
    for (const input of [undefined, null, 123456789012, ['a'.repeat(12)], {}]) {
      expect(normalizePassword(input)).toEqual({ ok: false, reason: 'TOO_SHORT' });
    }
  });

  it('rejects listed passwords regardless of case and normalization form', async () => {
    const checker = new ListCompromisedPasswordChecker();
    await expect(checker.isCompromised('Password1234')).resolves.toBe(true);
    await expect(checker.isCompromised('CONTRASEÑA123')).resolves.toBe(true);
    await expect(checker.isCompromised('a genuinely new phrase')).resolves.toBe(false);
  });

  it('loads a newline-separated list from a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trayvi-passwords-'));
    try {
      const path = join(directory, 'list.txt');
      await writeFile(path, 'first listed one\r\n\nSecond Listed One\n', 'utf8');
      const checker = await ListCompromisedPasswordChecker.fromFile(path);
      expect(checker.size).toBe(2);
      await expect(checker.isCompromised('second listed one')).resolves.toBe(true);
      await expect(checker.isCompromised('password1234')).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
