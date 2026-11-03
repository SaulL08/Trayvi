import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  DocumentNormalizationError,
  normalizeDominicanCedula,
} from '../domain/document-normalization';
import type {
  DocumentContext,
  DocumentScope,
  FingerprintAlias,
  FingerprintKey,
  FingerprintKeyring,
  KeyEncryptionProvider,
  KeyedCommitment,
  ProtectIdentityDocumentInput,
  ProtectedIdentityDocument,
  RandomBytesSource,
  RequestCommitter,
  WrappedDataEncryptionKey,
} from '../application/document-protection';

const FINGERPRINT_DOMAIN = 'trayvi.identity-document-fingerprint';
const ENVELOPE_DOMAIN = 'trayvi.identity-document-envelope';
const WRAP_DOMAIN = 'trayvi.identity-document-dek-wrap';
const IDEMPOTENCY_DOMAIN_PREFIX = 'trayvi.identity-enrollment-idempotency';
const KEY_MATERIAL_IDENTITY_DOMAIN = 'trayvi.key-material-identity';

export class DocumentProtectionError extends Error {
  readonly code:
    | 'KEY_VERSION_UNAVAILABLE'
    | 'INVALID_KEY_CONFIGURATION'
    | 'ENVELOPE_FAILURE'
    | 'INVALID_DOCUMENT_CONTEXT';

  constructor(code: DocumentProtectionError['code']) {
    super('Identity document protection failed.');
    this.name = 'DocumentProtectionError';
    this.code = code;
  }
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== 32) throw new DocumentProtectionError('INVALID_KEY_CONFIGURATION');
}

function assertVersion(version: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(version)) {
    throw new DocumentProtectionError('INVALID_KEY_CONFIGURATION');
  }
}

function keyMaterialIdentity(key: Buffer): Buffer {
  return createHash('sha256')
    .update(`${KEY_MATERIAL_IDENTITY_DOMAIN}\0`, 'utf8')
    .update(key)
    .digest();
}

/** Rejects any key material shared between two purposes (P1-AUD-004). */
function assertDisjointKeyPurposes(purposes: readonly (readonly Buffer[])[]): void {
  for (const [index, identities] of purposes.entries()) {
    for (const other of purposes.slice(index + 1)) {
      if (
        identities.some((identity) =>
          other.some(
            (candidate) =>
              candidate.byteLength === identity.byteLength && timingSafeEqual(candidate, identity),
          ),
        )
      ) {
        throw new DocumentProtectionError('INVALID_KEY_CONFIGURATION');
      }
    }
  }
}

function cloneKey(key: FingerprintKey): FingerprintKey {
  assertVersion(key.version);
  assertKey(key.key);
  return { ...key, key: Buffer.from(key.key) };
}

export class ConfiguredFingerprintKeyring implements FingerprintKeyring {
  readonly #keys: readonly FingerprintKey[];

  constructor(keys: readonly FingerprintKey[]) {
    const versions = keys.map((key) => key.version);
    if (
      keys.length === 0 ||
      new Set(versions).size !== versions.length ||
      keys.filter((key) => key.state === 'PRIMARY').length !== 1 ||
      keys.some((key, index) =>
        keys.slice(index + 1).some((candidate) => candidate.key.equals(key.key)),
      )
    ) {
      throw new DocumentProtectionError('INVALID_KEY_CONFIGURATION');
    }
    this.#keys = keys
      .map(cloneKey)
      .sort((left, right) => left.version.localeCompare(right.version));
  }

  lookupActive(): readonly FingerprintKey[] {
    return this.#keys.filter((key) => key.state !== 'RETIRED').map(cloneKey);
  }

  keyMaterialIdentities(): readonly Buffer[] {
    return this.#keys.map((key) => keyMaterialIdentity(key.key));
  }
}

function fingerprintInput(scope: DocumentScope, canonicalValue: string): Buffer {
  return Buffer.from(
    [
      FINGERPRINT_DOMAIN,
      scope.normalizationProfile,
      scope.countryCode,
      scope.issuerCode,
      scope.documentType,
      canonicalValue,
    ].join('\0'),
    'utf8',
  );
}

export function computeDocumentFingerprint(
  scope: DocumentScope,
  canonicalValue: string,
  key: FingerprintKey,
): FingerprintAlias {
  assertVersion(key.version);
  assertKey(key.key);
  return {
    algorithm: 'hmac-sha-256',
    keyVersion: key.version,
    fingerprint: createHmac('sha256', key.key)
      .update(fingerprintInput(scope, canonicalValue))
      .digest(),
  };
}

export function buildDocumentAad(context: DocumentContext): Buffer {
  return Buffer.from(
    `${ENVELOPE_DOMAIN}|v1|document=${context.documentId}|identity=${context.identityId}` +
      `|country=${context.countryCode}|issuer=${context.issuerCode}` +
      `|type=${context.documentType}|normalization=${context.normalizationProfile}`,
    'utf8',
  );
}

function commitmentInput(domain: string, fields: readonly string[]): Buffer {
  const framed = fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('|');
  return Buffer.from(`${IDEMPOTENCY_DOMAIN_PREFIX}\0${domain}\0${framed}`, 'utf8');
}

export class NodeKeyedRequestCommitter implements RequestCommitter {
  readonly #key: Buffer;
  readonly #keyVersion: string;

  constructor(keyVersion: string, key: Buffer) {
    assertVersion(keyVersion);
    assertKey(key);
    this.#keyVersion = keyVersion;
    this.#key = Buffer.from(key);
  }

  commit(domain: string, fields: readonly string[]): KeyedCommitment {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(domain)) {
      throw new DocumentProtectionError('INVALID_DOCUMENT_CONTEXT');
    }
    return {
      keyVersion: this.#keyVersion,
      value: createHmac('sha256', this.#key).update(commitmentInput(domain, fields)).digest(),
    };
  }

  keyMaterialIdentities(): readonly Buffer[] {
    return [keyMaterialIdentity(this.#key)];
  }
}

export class SyntheticAesGcmKeyEncryptionProvider implements KeyEncryptionProvider {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #primaryVersion: string;
  readonly #randomBytes: RandomBytesSource;

  constructor(
    primaryVersion: string,
    keys: ReadonlyMap<string, Buffer>,
    randomBytesSource: RandomBytesSource = randomBytes,
  ) {
    assertVersion(primaryVersion);
    if (!keys.has(primaryVersion)) throw new DocumentProtectionError('KEY_VERSION_UNAVAILABLE');
    const copies = new Map<string, Buffer>();
    for (const [version, key] of keys) {
      assertVersion(version);
      assertKey(key);
      copies.set(version, Buffer.from(key));
    }
    // Distinct KEK versions must not share material, mirroring the fingerprint keyring rule.
    assertDisjointKeyPurposes([...copies.values()].map((key) => [keyMaterialIdentity(key)]));
    this.#keys = copies;
    this.#primaryVersion = primaryVersion;
    this.#randomBytes = randomBytesSource;
  }

  keyMaterialIdentities(): readonly Buffer[] {
    return [...this.#keys.values()].map(keyMaterialIdentity);
  }

  async wrap(dek: Buffer): Promise<WrappedDataEncryptionKey> {
    assertKey(dek);
    const key = this.#keys.get(this.#primaryVersion);
    if (!key) throw new DocumentProtectionError('KEY_VERSION_UNAVAILABLE');
    const nonce = this.#randomBytes(12);
    if (nonce.byteLength !== 12) throw new DocumentProtectionError('ENVELOPE_FAILURE');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${WRAP_DOMAIN}\0${this.#primaryVersion}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      kekKeyVersion: this.#primaryVersion,
      wrappedDek: Buffer.concat([nonce, tag, ciphertext]),
    };
  }

  async unwrap(wrappedDek: Buffer, kekKeyVersion: string): Promise<Buffer> {
    const key = this.#keys.get(kekKeyVersion);
    if (!key) throw new DocumentProtectionError('KEY_VERSION_UNAVAILABLE');
    if (wrappedDek.byteLength !== 60) throw new DocumentProtectionError('ENVELOPE_FAILURE');
    try {
      const nonce = wrappedDek.subarray(0, 12);
      const tag = wrappedDek.subarray(12, 28);
      const ciphertext = wrappedDek.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`${WRAP_DOMAIN}\0${kekKeyVersion}`, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new DocumentProtectionError('ENVELOPE_FAILURE');
    }
  }

  async rewrap(wrappedDek: Buffer, kekKeyVersion: string): Promise<WrappedDataEncryptionKey> {
    const dek = await this.unwrap(wrappedDek, kekKeyVersion);
    try {
      return await this.wrap(dek);
    } finally {
      dek.fill(0);
    }
  }
}

export class NodeIdentityDocumentProtector {
  readonly #keyring: FingerprintKeyring;
  readonly #keyEncryptionProvider: KeyEncryptionProvider;
  readonly #requestCommitter: RequestCommitter;
  readonly #randomBytes: RandomBytesSource;

  constructor(
    keyring: FingerprintKeyring,
    keyEncryptionProvider: KeyEncryptionProvider,
    requestCommitter: RequestCommitter,
    randomBytesSource: RandomBytesSource = randomBytes,
  ) {
    assertDisjointKeyPurposes([
      keyring.keyMaterialIdentities(),
      keyEncryptionProvider.keyMaterialIdentities(),
      requestCommitter.keyMaterialIdentities(),
    ]);
    this.#keyring = keyring;
    this.#keyEncryptionProvider = keyEncryptionProvider;
    this.#requestCommitter = requestCommitter;
    this.#randomBytes = randomBytesSource;
  }

  commitNonDocumentRequest(domain: string, fields: readonly string[]): KeyedCommitment {
    return this.#requestCommitter.commit(domain, fields);
  }

  async protect(input: ProtectIdentityDocumentInput): Promise<ProtectedIdentityDocument> {
    if (
      input.countryCode !== 'DO' ||
      input.issuerCode !== 'JCE' ||
      input.documentType !== 'NATIONAL_ID' ||
      input.documentId.length === 0 ||
      input.identityId.length === 0
    ) {
      throw new DocumentProtectionError('INVALID_DOCUMENT_CONTEXT');
    }
    const normalized = normalizeDominicanCedula(input.documentValue);
    const context: DocumentContext = {
      documentId: input.documentId,
      identityId: input.identityId,
      countryCode: input.countryCode,
      issuerCode: input.issuerCode,
      documentType: input.documentType,
      normalizationProfile: normalized.profile,
    };
    const keys = this.#keyring.lookupActive();
    if (keys.length === 0) throw new DocumentProtectionError('KEY_VERSION_UNAVAILABLE');
    const fingerprintAliases = keys.map((key) =>
      computeDocumentFingerprint(context, normalized.canonicalValue, key),
    );
    const requestCommitment = this.#requestCommitter.commit('submit-identity.v1', [
      context.countryCode,
      context.issuerCode,
      context.documentType,
      context.normalizationProfile,
      normalized.canonicalValue,
    ]);

    const dek = this.#randomBytes(32);
    const nonce = this.#randomBytes(12);
    if (dek.byteLength !== 32 || nonce.byteLength !== 12) {
      dek.fill(0);
      throw new DocumentProtectionError('ENVELOPE_FAILURE');
    }
    try {
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(buildDocumentAad(context));
      const ciphertext = Buffer.concat([
        cipher.update(normalized.canonicalValue, 'utf8'),
        cipher.final(),
      ]);
      const wrapped = await this.#keyEncryptionProvider.wrap(dek);
      return {
        context,
        envelope: {
          algorithm: 'aes-256-gcm',
          schemaVersion: 1,
          kekKeyVersion: wrapped.kekKeyVersion,
          ciphertext,
          nonce: Buffer.from(nonce),
          authenticationTag: cipher.getAuthTag(),
          wrappedDek: wrapped.wrappedDek,
        },
        fingerprintAliases,
        requestCommitment: requestCommitment.value,
        requestCommitmentKeyVersion: requestCommitment.keyVersion,
      };
    } catch (error: unknown) {
      if (error instanceof DocumentProtectionError || error instanceof DocumentNormalizationError) {
        throw error;
      }
      throw new DocumentProtectionError('ENVELOPE_FAILURE');
    } finally {
      dek.fill(0);
    }
  }

  async computeRotationAliases(
    document: ProtectedIdentityDocument,
    targetKeyring: FingerprintKeyring,
  ): Promise<readonly FingerprintAlias[]> {
    assertDisjointKeyPurposes([
      targetKeyring.keyMaterialIdentities(),
      this.#keyEncryptionProvider.keyMaterialIdentities(),
      this.#requestCommitter.keyMaterialIdentities(),
    ]);
    const plaintext = await this.#recoverCanonicalDocument(document);
    try {
      const canonicalValue = plaintext.toString('utf8');
      return targetKeyring
        .lookupActive()
        .map((key) => computeDocumentFingerprint(document.context, canonicalValue, key));
    } finally {
      plaintext.fill(0);
    }
  }

  async verifyEnvelope(document: ProtectedIdentityDocument): Promise<void> {
    const plaintext = await this.#recoverCanonicalDocument(document);
    plaintext.fill(0);
  }

  async #recoverCanonicalDocument(document: ProtectedIdentityDocument): Promise<Buffer> {
    let plaintext: Buffer | undefined;
    try {
      const dek = await this.#keyEncryptionProvider.unwrap(
        document.envelope.wrappedDek,
        document.envelope.kekKeyVersion,
      );
      try {
        const decipher = createDecipheriv('aes-256-gcm', dek, document.envelope.nonce);
        decipher.setAAD(buildDocumentAad(document.context));
        decipher.setAuthTag(document.envelope.authenticationTag);
        plaintext = Buffer.concat([
          decipher.update(document.envelope.ciphertext),
          decipher.final(),
        ]);
      } finally {
        dek.fill(0);
      }
      const normalized = normalizeDominicanCedula(plaintext.toString('utf8'));
      if (
        normalized.profile !== document.context.normalizationProfile ||
        !timingSafeEqual(Buffer.from(normalized.canonicalValue), plaintext)
      ) {
        throw new DocumentProtectionError('ENVELOPE_FAILURE');
      }
      return plaintext;
    } catch (error: unknown) {
      plaintext?.fill(0);
      if (error instanceof DocumentProtectionError) throw error;
      throw new DocumentProtectionError('ENVELOPE_FAILURE');
    }
  }
}

export const DOCUMENT_FINGERPRINT_DOMAIN = FINGERPRINT_DOMAIN;
export const DOCUMENT_ENVELOPE_DOMAIN = ENVELOPE_DOMAIN;
