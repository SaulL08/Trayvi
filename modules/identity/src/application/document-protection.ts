export interface DocumentScope {
  readonly countryCode: string;
  readonly issuerCode: string;
  readonly documentType: string;
  readonly normalizationProfile: string;
}

export interface DocumentContext extends DocumentScope {
  readonly documentId: string;
  readonly identityId: string;
}

export interface FingerprintAlias {
  readonly algorithm: 'hmac-sha-256';
  readonly keyVersion: string;
  readonly fingerprint: Buffer;
}

export interface EncryptedDocumentEnvelope {
  readonly algorithm: 'aes-256-gcm';
  readonly schemaVersion: 1;
  readonly kekKeyVersion: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authenticationTag: Buffer;
  readonly wrappedDek: Buffer;
}

export interface ProtectedIdentityDocument {
  readonly context: DocumentContext;
  readonly envelope: EncryptedDocumentEnvelope;
  readonly fingerprintAliases: readonly FingerprintAlias[];
  readonly requestCommitment: Buffer;
  readonly requestCommitmentKeyVersion: string;
}

export interface FingerprintKey {
  readonly version: string;
  readonly key: Buffer;
  readonly state: 'PRIMARY' | 'LOOKUP_ACTIVE' | 'RETIRED';
}

export interface FingerprintKeyring {
  lookupActive(): readonly FingerprintKey[];
}

export interface WrappedDataEncryptionKey {
  readonly kekKeyVersion: string;
  readonly wrappedDek: Buffer;
}

export interface KeyEncryptionProvider {
  wrap(dek: Buffer): Promise<WrappedDataEncryptionKey>;
  unwrap(wrappedDek: Buffer, kekKeyVersion: string): Promise<Buffer>;
  rewrap(wrappedDek: Buffer, kekKeyVersion: string): Promise<WrappedDataEncryptionKey>;
}

export interface KeyedCommitment {
  readonly keyVersion: string;
  readonly value: Buffer;
}

export interface RequestCommitter {
  commit(domain: string, fields: readonly string[]): KeyedCommitment;
}

export type RandomBytesSource = (size: number) => Buffer;

export interface ProtectIdentityDocumentInput {
  readonly documentId: string;
  readonly identityId: string;
  readonly countryCode: 'DO';
  readonly issuerCode: 'JCE';
  readonly documentType: 'NATIONAL_ID';
  readonly documentValue: unknown;
}
