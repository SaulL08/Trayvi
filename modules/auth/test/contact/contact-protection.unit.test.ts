import { describe, expect, it } from 'vitest';

import type { NormalizedPhone } from '../../src/contracts/contact';
import { AuthKeyError, type AuthKeyPurpose, type VersionedKey } from '../../src/contracts/keys';
import {
  buildContactEnvelopeAad,
  computeContactFingerprint,
  ContactEnvelopeCipher,
  ContactProtectionError,
  decryptContactValue,
  encryptContactValue,
  HmacContactFingerprinter,
  NodeContactEnvelopeSealer,
} from '../../src/infrastructure/contact/contact-protection';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';

const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const phone: NormalizedPhone = { profile: 'e164-v1', canonical: '+18095550100' };
const contactId = '018f0000-0000-7000-8000-0000000000b1';

const fingerprintKey = hex('404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f');
const vectorDek = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
const vectorNonce = hex('0c0d0e0f1011121314151617');
const vectorAad =
  'trayvi.auth-contact-envelope|v1|contact=018f0000-0000-7000-8000-0000000000b1|channel=PHONE|normalization=e164-v1';
const vectorCiphertext = hex('e998d3dddde7baf976b1efc4');
const vectorTag = hex('d839844bdf102b3ad3664a0f1465b77e');

function key(
  purpose: AuthKeyPurpose,
  fill: number,
  version = 'v1',
  state: VersionedKey['state'] = 'PRIMARY',
): VersionedKey {
  return { purpose, version, state, material: Buffer.alloc(32, fill) };
}

function keyring(extra: readonly VersionedKey[] = []): ConfiguredAuthKeyring {
  return new ConfiguredAuthKeyring([
    {
      purpose: 'auth-contact-fingerprint',
      version: 'v1',
      state: 'PRIMARY',
      material: fingerprintKey,
    },
    key('auth-contact-kek', 2),
    key('auth-otp-commitment', 3),
    key('auth-subject-commitment', 4),
    ...extra,
  ]);
}

describe('contact fingerprint (PLAN §7.1)', () => {
  it('reproduces the synthetic vector', () => {
    expect(computeContactFingerprint(fingerprintKey, phone).toString('hex')).toBe(
      'cee3593473f50dd0bc86721df094a11e4023d5d984334ecb907b35daec322125',
    );
  });

  it('changes when any field, separator, encoding, or key changes', () => {
    const baseline = computeContactFingerprint(fingerprintKey, phone).toString('hex');
    const variants = [
      computeContactFingerprint(fingerprintKey, { ...phone, canonical: '+18095550101' }),
      computeContactFingerprint(fingerprintKey, {
        profile: 'e164-v2' as 'e164-v1',
        canonical: phone.canonical,
      }),
      computeContactFingerprint(Buffer.alloc(32, 9), phone),
    ];
    for (const variant of variants) expect(variant.toString('hex')).not.toBe(baseline);
  });

  it('returns the primary first and one alias per lookup-active key version', () => {
    const fingerprinter = new HmacContactFingerprinter(
      keyring([key('auth-contact-fingerprint', 7, 'v0', 'LOOKUP_ACTIVE')]),
    );
    const set = fingerprinter.fingerprint(phone);
    expect(set.primary.keyVersion).toBe('v1');
    expect(set.primary.bytes.toString('hex')).toBe(
      'cee3593473f50dd0bc86721df094a11e4023d5d984334ecb907b35daec322125',
    );
    expect(set.lookup.map((entry) => entry.keyVersion)).toEqual(['v1', 'v0']);
    expect(set.lookup.every((entry) => entry.bytes.byteLength === 32)).toBe(true);
  });
});

describe('contact envelope (PLAN §7.2)', () => {
  it('decrypts the synthetic vector and reproduces it from the same DEK and nonce', () => {
    const aad = buildContactEnvelopeAad(contactId);
    expect(aad.toString('utf8')).toBe(vectorAad);
    expect(
      decryptContactValue(
        vectorDek,
        { nonce: vectorNonce, tag: vectorTag, ciphertext: vectorCiphertext },
        aad,
      ),
    ).toEqual(phone);
    const sealed = encryptContactValue(vectorDek, vectorNonce, aad, phone.canonical);
    expect(sealed.ciphertext.toString('hex')).toBe(vectorCiphertext.toString('hex'));
    expect(sealed.tag.toString('hex')).toBe(vectorTag.toString('hex'));
  });

  it('rejects changed ciphertext, tag, nonce, AAD field, or key', () => {
    const flip = (value: Buffer): Buffer => {
      const copy = Buffer.from(value);
      copy[0] = (copy[0] ?? 0) ^ 0x01;
      return copy;
    };
    const aad = buildContactEnvelopeAad(contactId);
    const parts = { nonce: vectorNonce, tag: vectorTag, ciphertext: vectorCiphertext };
    const mutations: readonly (readonly [Buffer, typeof parts, Buffer])[] = [
      [vectorDek, { ...parts, ciphertext: flip(vectorCiphertext) }, aad],
      [vectorDek, { ...parts, tag: flip(vectorTag) }, aad],
      [vectorDek, { ...parts, nonce: flip(vectorNonce) }, aad],
      [vectorDek, parts, buildContactEnvelopeAad('018f0000-0000-7000-8000-0000000000b2')],
      [vectorDek, parts, Buffer.from(vectorAad.replace('channel=PHONE', 'channel=EMAIL'))],
      [vectorDek, parts, Buffer.from(vectorAad.replace('|v1|', '|v2|'))],
      [flip(vectorDek), parts, aad],
    ];
    for (const [dek, mutated, mutatedAad] of mutations) {
      expect(() => decryptContactValue(dek, mutated, mutatedAad)).toThrow(ContactProtectionError);
    }
  });

  it('uses a fresh random DEK and nonce per record and round-trips through the KEK wrap', () => {
    const cipher = new ContactEnvelopeCipher(keyring());
    const aad = buildContactEnvelopeAad(contactId);
    const first = cipher.seal(phone, aad);
    const second = cipher.seal(phone, aad);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.wrappedDek.byteLength).toBe(60);
    expect(first.kekVersion).toBe('v1');
    expect(cipher.open(first, aad)).toEqual(phone);
  });

  it('fails closed on a wrong KEK, a retired KEK version, or a tampered wrapped DEK', () => {
    const aad = buildContactEnvelopeAad(contactId);
    const sealed = new ContactEnvelopeCipher(keyring()).seal(phone, aad);
    const otherKek = new ConfiguredAuthKeyring([
      {
        purpose: 'auth-contact-fingerprint',
        version: 'v1',
        state: 'PRIMARY',
        material: fingerprintKey,
      },
      key('auth-contact-kek', 12),
      key('auth-otp-commitment', 3),
      key('auth-subject-commitment', 4),
    ]);
    expect(() => new ContactEnvelopeCipher(otherKek).open(sealed, aad)).toThrow(
      ContactProtectionError,
    );
    const rotated = new ConfiguredAuthKeyring([
      {
        purpose: 'auth-contact-fingerprint',
        version: 'v1',
        state: 'PRIMARY',
        material: fingerprintKey,
      },
      key('auth-contact-kek', 2, 'v1', 'RETIRED'),
      key('auth-contact-kek', 13, 'v2'),
      key('auth-otp-commitment', 3),
      key('auth-subject-commitment', 4),
    ]);
    expect(() => new ContactEnvelopeCipher(rotated).open(sealed, aad)).toThrow(AuthKeyError);
    const tampered = Buffer.from(sealed.wrappedDek);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    expect(() =>
      new ContactEnvelopeCipher(keyring()).open({ ...sealed, wrappedDek: tampered }, aad),
    ).toThrow(ContactProtectionError);
  });

  it('refuses owner IDs that could inject AAD separators', () => {
    expect(() => buildContactEnvelopeAad(`${contactId}|channel=EMAIL`)).toThrow(
      ContactProtectionError,
    );
    expect(() => buildContactEnvelopeAad('not-a-uuid')).toThrow(ContactProtectionError);
  });
});

describe('ContactEnvelopeSealer (pending contacts)', () => {
  const ownerId = '018f0000-0000-7000-8000-0000000000f1';

  it('round-trips under the pending-contact AAD and fails under a different owner', async () => {
    const sealer = new NodeContactEnvelopeSealer(new ContactEnvelopeCipher(keyring()));
    const sealed = await sealer.seal(phone, ownerId);
    expect(sealed.profile).toBe('e164-v1');
    await expect(sealer.open(sealed, ownerId)).resolves.toEqual(phone);
    await expect(
      sealer.open(sealed, '018f0000-0000-7000-8000-0000000000f2'),
    ).rejects.toBeInstanceOf(ContactProtectionError);
  });

  it('cannot open a contact-point envelope as a pending contact, or the reverse', async () => {
    const cipher = new ContactEnvelopeCipher(keyring());
    const sealer = new NodeContactEnvelopeSealer(cipher);
    const contactEnvelope = cipher.seal(phone, buildContactEnvelopeAad(ownerId));
    await expect(
      sealer.open(
        {
          profile: 'e164-v1',
          ciphertext: contactEnvelope.ciphertext,
          nonce: contactEnvelope.nonce,
          tag: contactEnvelope.tag,
          wrappedKey: contactEnvelope.wrappedDek,
          kekVersion: contactEnvelope.kekVersion,
        },
        ownerId,
      ),
    ).rejects.toBeInstanceOf(ContactProtectionError);
    const pending = await sealer.seal(phone, ownerId);
    expect(() =>
      cipher.open({ ...pending, wrappedDek: pending.wrappedKey }, buildContactEnvelopeAad(ownerId)),
    ).toThrow(ContactProtectionError);
  });
});

describe('Auth key separation at startup (R-05)', () => {
  it('fails when contact keys share bytes with another Auth purpose or with Identity keys', () => {
    const identityDocumentFingerprintKey = Buffer.alloc(32, 0x55);
    const codeOf = (run: () => unknown): string | undefined => {
      try {
        run();
        return undefined;
      } catch (error: unknown) {
        return error instanceof AuthKeyError ? error.code : 'UNEXPECTED';
      }
    };
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring([
            {
              purpose: 'auth-contact-fingerprint',
              version: 'v1',
              state: 'PRIMARY',
              material: fingerprintKey,
            },
            {
              purpose: 'auth-contact-kek',
              version: 'v1',
              state: 'PRIMARY',
              material: fingerprintKey,
            },
            key('auth-otp-commitment', 3),
            key('auth-subject-commitment', 4),
          ]),
      ),
    ).toBe('KEY_PURPOSE_COLLISION');
    expect(
      codeOf(
        () =>
          new ConfiguredAuthKeyring(
            [
              {
                purpose: 'auth-contact-fingerprint',
                version: 'v1',
                state: 'PRIMARY',
                material: Buffer.from(identityDocumentFingerprintKey),
              },
              key('auth-contact-kek', 2),
              key('auth-otp-commitment', 3),
              key('auth-subject-commitment', 4),
            ],
            { foreignKeyMaterial: [identityDocumentFingerprintKey] },
          ),
      ),
    ).toBe('KEY_PURPOSE_COLLISION');
  });
});
