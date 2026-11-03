import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ConfiguredFingerprintKeyring,
  DocumentProtectionError,
  NodeIdentityDocumentProtector,
  NodeKeyedRequestCommitter,
  SyntheticAesGcmKeyEncryptionProvider,
  computeDocumentFingerprint,
} from '../src';
import type { ProtectedIdentityDocument, RandomBytesSource } from '../src';

const fingerprintKey = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const dek = Buffer.from('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f', 'hex');
const nonce = Buffer.from('000102030405060708090a0b', 'hex');
const kek = Buffer.from('404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f', 'hex');
const idempotencyKey = Buffer.from(
  '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f',
  'hex',
);
const context = {
  documentId: '018f0000-0000-7000-8000-000000000001',
  identityId: '018f0000-0000-7000-8000-000000000002',
  countryCode: 'DO' as const,
  issuerCode: 'JCE' as const,
  documentType: 'NATIONAL_ID' as const,
};

function deterministicBytes(values: readonly Buffer[]): RandomBytesSource {
  const queue = values.map((value) => Buffer.from(value));
  return (size) => {
    const value = queue.shift();
    if (!value || value.byteLength !== size) throw new Error('unexpected deterministic request');
    return value;
  };
}

function buildProtector(): NodeIdentityDocumentProtector {
  const random = deterministicBytes([dek, nonce, Buffer.alloc(12, 9)]);
  return new NodeIdentityDocumentProtector(
    new ConfiguredFingerprintKeyring([
      { version: 'fingerprint-v1', key: fingerprintKey, state: 'PRIMARY' },
    ]),
    new SyntheticAesGcmKeyEncryptionProvider('kek-v1', new Map([['kek-v1', kek]]), random),
    new NodeKeyedRequestCommitter('idempotency-v1', idempotencyKey),
    random,
  );
}

function buildDecryptor(kekMaterial: Buffer): NodeIdentityDocumentProtector {
  return new NodeIdentityDocumentProtector(
    new ConfiguredFingerprintKeyring([
      { version: 'fingerprint-v1', key: fingerprintKey, state: 'PRIMARY' },
    ]),
    new SyntheticAesGcmKeyEncryptionProvider('kek-v1', new Map([['kek-v1', kekMaterial]])),
    new NodeKeyedRequestCommitter('idempotency-v1', idempotencyKey),
  );
}

describe('national document protection', () => {
  it('reproduces the domain-separated HMAC-SHA-256 vector', () => {
    const alias = computeDocumentFingerprint(
      { ...context, normalizationProfile: 'do-cedula-v1' },
      '00112345678',
      { version: 'fingerprint-v1', key: fingerprintKey, state: 'PRIMARY' },
    );
    expect(alias.fingerprint.toString('hex')).toBe(
      '297d981c7626bf7d24a9372b0bf8bea65631f1db0a5e4622f932e0e77b61091f',
    );
  });

  it('separates every fingerprint scope field, key, and value', () => {
    const scope = { ...context, normalizationProfile: 'do-cedula-v1' };
    const base = computeDocumentFingerprint(scope, '00112345678', {
      version: 'v1',
      key: fingerprintKey,
      state: 'PRIMARY',
    }).fingerprint;
    const variants = [
      computeDocumentFingerprint({ ...scope, countryCode: 'ZZ' }, '00112345678', {
        version: 'v1',
        key: fingerprintKey,
        state: 'PRIMARY',
      }).fingerprint,
      computeDocumentFingerprint({ ...scope, issuerCode: 'OTHER' }, '00112345678', {
        version: 'v1',
        key: fingerprintKey,
        state: 'PRIMARY',
      }).fingerprint,
      computeDocumentFingerprint({ ...scope, documentType: 'OTHER' }, '00112345678', {
        version: 'v1',
        key: fingerprintKey,
        state: 'PRIMARY',
      }).fingerprint,
      computeDocumentFingerprint({ ...scope, normalizationProfile: 'v2' }, '00112345678', {
        version: 'v1',
        key: fingerprintKey,
        state: 'PRIMARY',
      }).fingerprint,
      computeDocumentFingerprint(scope, '00112345679', {
        version: 'v1',
        key: fingerprintKey,
        state: 'PRIMARY',
      }).fingerprint,
      computeDocumentFingerprint(scope, '00112345678', {
        version: 'v2',
        key: Buffer.alloc(32, 99),
        state: 'PRIMARY',
      }).fingerprint,
    ];
    expect(variants.every((variant) => !variant.equals(base))).toBe(true);
  });

  it('changes the digest for separator and byte-encoding mutations', () => {
    const exactInput = [
      'trayvi.identity-document-fingerprint',
      'do-cedula-v1',
      'DO',
      'JCE',
      'NATIONAL_ID',
      '00112345678',
    ].join('\0');
    const exact = createHmac('sha256', fingerprintKey).update(exactInput, 'utf8').digest();
    const mutations = [
      createHmac('sha256', fingerprintKey)
        .update(exactInput.replaceAll('\0', '|'), 'utf8')
        .digest(),
      createHmac('sha256', fingerprintKey).update(Buffer.from(exactInput, 'utf16le')).digest(),
      createHmac('sha256', fingerprintKey)
        .update(
          exactInput.replace('trayvi.identity-document-fingerprint', 'trayvi.identity'),
          'utf8',
        )
        .digest(),
    ];

    expect(mutations.every((mutation) => !mutation.equals(exact))).toBe(true);
  });

  it('models primary, lookup-active, and retired key states and rejects reused key material', () => {
    const keyring = new ConfiguredFingerprintKeyring([
      { version: 'v1', key: fingerprintKey, state: 'LOOKUP_ACTIVE' },
      { version: 'v2', key: Buffer.alloc(32, 2), state: 'PRIMARY' },
      { version: 'v0', key: Buffer.alloc(32, 3), state: 'RETIRED' },
    ]);
    expect(keyring.lookupActive().map((key) => [key.version, key.state])).toEqual([
      ['v1', 'LOOKUP_ACTIVE'],
      ['v2', 'PRIMARY'],
    ]);
    expect(
      () =>
        new ConfiguredFingerprintKeyring([
          { version: 'v1', key: fingerprintKey, state: 'LOOKUP_ACTIVE' },
          { version: 'v2', key: fingerprintKey, state: 'PRIMARY' },
        ]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_KEY_CONFIGURATION' }));
  });

  it('rejects the same key material serving two purposes', async () => {
    const shared = Buffer.alloc(32, 77);
    const keyring = (key: Buffer, state: 'PRIMARY' | 'RETIRED' = 'PRIMARY') =>
      new ConfiguredFingerprintKeyring(
        state === 'PRIMARY'
          ? [{ version: 'fingerprint-v1', key, state }]
          : [
              { version: 'fingerprint-v0', key, state },
              { version: 'fingerprint-v1', key: fingerprintKey, state: 'PRIMARY' },
            ],
      );
    const provider = (key: Buffer) =>
      new SyntheticAesGcmKeyEncryptionProvider('kek-v1', new Map([['kek-v1', key]]));
    const committer = (key: Buffer) => new NodeKeyedRequestCommitter('idempotency-v1', key);
    const invalid = expect.objectContaining({ code: 'INVALID_KEY_CONFIGURATION' });

    for (const build of [
      () =>
        new NodeIdentityDocumentProtector(
          keyring(shared),
          provider(shared),
          committer(idempotencyKey),
        ),
      () => new NodeIdentityDocumentProtector(keyring(shared), provider(kek), committer(shared)),
      () =>
        new NodeIdentityDocumentProtector(
          keyring(fingerprintKey),
          provider(shared),
          committer(shared),
        ),
      () =>
        new NodeIdentityDocumentProtector(
          keyring(shared, 'RETIRED'),
          provider(shared),
          committer(idempotencyKey),
        ),
    ]) {
      expect(build).toThrowError(invalid);
    }
    expect(
      () =>
        new SyntheticAesGcmKeyEncryptionProvider(
          'kek-v2',
          new Map([
            ['kek-v1', kek],
            ['kek-v2', kek],
          ]),
        ),
    ).toThrowError(invalid);

    const protector = new NodeIdentityDocumentProtector(
      keyring(fingerprintKey),
      provider(kek),
      committer(idempotencyKey),
    );
    const protectedDocument = await protector.protect({ ...context, documentValue: '00112345678' });
    await expect(
      protector.computeRotationAliases(protectedDocument, keyring(kek)),
    ).rejects.toMatchObject({ code: 'INVALID_KEY_CONFIGURATION' });
    expect(
      [
        ...keyring(fingerprintKey).keyMaterialIdentities(),
        ...provider(kek).keyMaterialIdentities(),
        ...committer(idempotencyKey).keyMaterialIdentities(),
      ].every(
        (identity) =>
          identity.byteLength === 32 &&
          ![fingerprintKey, kek, idempotencyKey].some((key) => key.equals(identity)),
      ),
    ).toBe(true);
  });

  it('reproduces the AES-256-GCM envelope vector without exposing plaintext', async () => {
    const protectedDocument = await buildProtector().protect({
      ...context,
      documentValue: '001-1234567-8',
    });

    expect(protectedDocument.envelope).toMatchObject({
      algorithm: 'aes-256-gcm',
      schemaVersion: 1,
      kekKeyVersion: 'kek-v1',
    });
    expect(protectedDocument.envelope.ciphertext.toString('hex')).toBe('6c626c967806dfd98acef1');
    expect(protectedDocument.envelope.authenticationTag.toString('hex')).toBe(
      '9a778f58998539b82075c2fe99329536',
    );
    expect(protectedDocument.envelope.wrappedDek).toHaveLength(60);
    expect(JSON.stringify(protectedDocument)).not.toContain('00112345678');
  });

  it('decrypts only inside rotation and produces dual active aliases', async () => {
    const protector = buildProtector();
    const protectedDocument = await protector.protect({
      ...context,
      documentValue: '00112345678',
    });
    const rotated = await protector.computeRotationAliases(
      protectedDocument,
      new ConfiguredFingerprintKeyring([
        { version: 'fingerprint-v1', key: fingerprintKey, state: 'LOOKUP_ACTIVE' },
        { version: 'fingerprint-v2', key: Buffer.alloc(32, 88), state: 'PRIMARY' },
      ]),
    );

    expect(rotated.map((alias) => alias.keyVersion)).toEqual(['fingerprint-v1', 'fingerprint-v2']);
    expect(rotated[0]?.fingerprint.equals(rotated[1]?.fingerprint ?? Buffer.alloc(0))).toBe(false);
  });

  it.each([
    'ciphertext',
    'tag',
    'nonce',
    'document-aad',
    'identity-aad',
    'country-aad',
    'issuer-aad',
    'type-aad',
    'normalization-aad',
    'kek-version',
    'wrong-kek',
  ] as const)('fails closed when %s is modified', async (mutation) => {
    const protector = buildProtector();
    const original = await protector.protect({ ...context, documentValue: '00112345678' });
    const document: ProtectedIdentityDocument = {
      ...original,
      context: {
        ...original.context,
        documentId:
          mutation === 'document-aad'
            ? '018f0000-0000-7000-8000-000000000099'
            : original.context.documentId,
        identityId:
          mutation === 'identity-aad'
            ? '018f0000-0000-7000-8000-000000000099'
            : original.context.identityId,
        countryCode: mutation === 'country-aad' ? 'ZZ' : original.context.countryCode,
        issuerCode: mutation === 'issuer-aad' ? 'OTHER' : original.context.issuerCode,
        documentType: mutation === 'type-aad' ? 'OTHER' : original.context.documentType,
        normalizationProfile:
          mutation === 'normalization-aad' ? 'do-cedula-v2' : original.context.normalizationProfile,
      },
      envelope: {
        ...original.envelope,
        ciphertext:
          mutation === 'ciphertext'
            ? Buffer.from(
                original.envelope.ciphertext.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
              )
            : original.envelope.ciphertext,
        authenticationTag:
          mutation === 'tag'
            ? Buffer.from(
                original.envelope.authenticationTag.map((byte, index) =>
                  index === 0 ? byte ^ 1 : byte,
                ),
              )
            : original.envelope.authenticationTag,
        nonce:
          mutation === 'nonce'
            ? Buffer.from(
                original.envelope.nonce.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
              )
            : original.envelope.nonce,
        kekKeyVersion: mutation === 'kek-version' ? 'missing-kek' : original.envelope.kekKeyVersion,
      },
    };
    const decryptor = mutation === 'wrong-kek' ? buildDecryptor(Buffer.alloc(32, 77)) : protector;
    await expect(
      decryptor.computeRotationAliases(
        document,
        new ConfiguredFingerprintKeyring([
          { version: 'v2', key: Buffer.alloc(32, 2), state: 'PRIMARY' },
        ]),
      ),
    ).rejects.toBeInstanceOf(DocumentProtectionError);
  });

  it('rewraps a DEK under a new KEK version without rewriting its value', async () => {
    const oldProvider = new SyntheticAesGcmKeyEncryptionProvider(
      'kek-v1',
      new Map([
        ['kek-v1', kek],
        ['kek-v2', Buffer.alloc(32, 44)],
      ]),
      deterministicBytes([Buffer.alloc(12, 1)]),
    );
    const wrapped = await oldProvider.wrap(dek);
    const newProvider = new SyntheticAesGcmKeyEncryptionProvider(
      'kek-v2',
      new Map([
        ['kek-v1', kek],
        ['kek-v2', Buffer.alloc(32, 44)],
      ]),
      deterministicBytes([Buffer.alloc(12, 2)]),
    );
    const rewrapped = await newProvider.rewrap(wrapped.wrappedDek, wrapped.kekKeyVersion);
    const recovered = await newProvider.unwrap(rewrapped.wrappedDek, rewrapped.kekKeyVersion);

    expect(rewrapped.kekKeyVersion).toBe('kek-v2');
    expect(rewrapped.wrappedDek.equals(wrapped.wrappedDek)).toBe(false);
    expect(recovered.equals(dek)).toBe(true);
    recovered.fill(0);
  });

  it('uses a separate keyed and domain-separated idempotency commitment', () => {
    const committer = new NodeKeyedRequestCommitter('idempotency-v1', idempotencyKey);
    const first = committer.commit('submit-identity.v1', ['DO', '00112345678']);
    const replay = committer.commit('submit-identity.v1', ['DO', '00112345678']);
    const otherDomain = committer.commit('start-account.v1', ['DO', '00112345678']);

    expect(first.value.equals(replay.value)).toBe(true);
    expect(first.value.equals(otherDomain.value)).toBe(false);
    expect(first.value.equals(fingerprintKey)).toBe(false);
  });
});
