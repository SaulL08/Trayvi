import { timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

import type {
  ConfiguredFingerprintKeyring,
  FingerprintClaimStatus,
  KeyEncryptionProvider,
  NodeIdentityDocumentProtector,
  ProtectedIdentityDocument,
} from '@trayvi/identity';

interface ProtectedDocumentRow {
  readonly id: string;
  readonly identity_id: string;
  readonly country_code: string;
  readonly issuer_code: string;
  readonly document_type: string;
  readonly normalization_profile: string;
  readonly encryption_algorithm: 'aes-256-gcm';
  readonly encryption_schema_version: 1;
  readonly kek_key_version: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authentication_tag: Buffer;
  readonly wrapped_dek: Buffer;
  readonly claim_state: FingerprintClaimStatus;
}

export interface FingerprintBackfillInput {
  readonly documentId: string;
  readonly targetKeyring: ConfiguredFingerprintKeyring;
  readonly aliasIdFactory: () => string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export class PostgresFingerprintRotationStore {
  readonly #pool: Pool;
  readonly #protector: NodeIdentityDocumentProtector;

  constructor(pool: Pool, protector: NodeIdentityDocumentProtector) {
    this.#pool = pool;
    this.#protector = protector;
  }

  async backfill(input: FingerprintBackfillInput): Promise<number> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ProtectedDocumentRow>(
        `SELECT document.id,
                document.identity_id,
                document.country_code,
                document.issuer_code,
                document.document_type,
                document.normalization_profile,
                document.encryption_algorithm,
                document.encryption_schema_version,
                document.kek_key_version,
                document.ciphertext,
                document.nonce,
                document.authentication_tag,
                document.wrapped_dek,
                claim.state AS claim_state
         FROM identity.identity_documents document
         JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
         WHERE document.id = $1
           AND document.state <> 'CRYPTOSHREDDED'
           AND claim.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
         ORDER BY claim.created_at, claim.id
         LIMIT 1
         FOR UPDATE OF document`,
        [input.documentId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('ROTATION_DOCUMENT_UNAVAILABLE');
      const protectedDocument: ProtectedIdentityDocument = {
        context: {
          documentId: row.id,
          identityId: row.identity_id,
          countryCode: row.country_code,
          issuerCode: row.issuer_code,
          documentType: row.document_type,
          normalizationProfile: row.normalization_profile,
        },
        envelope: {
          algorithm: row.encryption_algorithm,
          schemaVersion: row.encryption_schema_version,
          kekKeyVersion: row.kek_key_version,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authenticationTag: row.authentication_tag,
          wrappedDek: row.wrapped_dek,
        },
        fingerprintAliases: [],
        requestCommitment: Buffer.alloc(32),
        requestCommitmentKeyVersion: 'rotation-only',
      };
      const aliases = await this.#protector.computeRotationAliases(
        protectedDocument,
        input.targetKeyring,
      );
      for (const alias of aliases) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO identity.document_fingerprint_claims (
             id, document_id, country_code, issuer_code, document_type,
             normalization_profile, hmac_algorithm, hmac_key_version,
             fingerprint, state, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RESERVED', $10)
           ON CONFLICT (document_id, hmac_key_version) DO NOTHING
           RETURNING id`,
          [
            input.aliasIdFactory(),
            row.id,
            row.country_code,
            row.issuer_code,
            row.document_type,
            row.normalization_profile,
            alias.algorithm,
            alias.keyVersion,
            alias.fingerprint,
            input.occurredAt,
          ],
        );
        const claimId = inserted.rows[0]?.id;
        if (claimId && row.claim_state === 'BOUND') {
          await client.query(
            `UPDATE identity.document_fingerprint_claims
             SET state = 'BOUND', bound_at = $2 WHERE id = $1`,
            [claimId, input.occurredAt],
          );
        } else if (claimId && row.claim_state === 'TOMBSTONED') {
          await client.query(
            `UPDATE identity.document_fingerprint_claims
             SET state = 'TOMBSTONED', tombstoned_at = $2 WHERE id = $1`,
            [claimId, input.occurredAt],
          );
        }
      }

      const targetVersions = aliases.map((alias) => alias.keyVersion);
      const verified = await client.query<{
        hmac_key_version: string;
        fingerprint: Buffer;
        state: FingerprintClaimStatus;
      }>(
        `SELECT hmac_key_version, fingerprint, state
         FROM identity.document_fingerprint_claims
         WHERE document_id = $1 AND hmac_key_version = ANY($2::text[])
           AND state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
         ORDER BY hmac_key_version`,
        [row.id, targetVersions],
      );
      const complete = aliases.every((alias) => {
        const candidate = verified.rows.find(
          (claim) => claim.hmac_key_version === alias.keyVersion,
        );
        return (
          candidate !== undefined &&
          candidate.state === row.claim_state &&
          candidate.fingerprint.byteLength === alias.fingerprint.byteLength &&
          timingSafeEqual(candidate.fingerprint, alias.fingerprint)
        );
      });
      if (verified.rows.length !== targetVersions.length || !complete) {
        throw new Error('ROTATION_BACKFILL_INCOMPLETE');
      }
      await client.query(
        `INSERT INTO platform.outbox_events (
           id, event_type, schema_version, aggregate_type, aggregate_id,
           occurred_at, correlation_id, payload
         ) VALUES ($1, 'identity.fingerprint_rotation_backfilled', 1,
           'identity', $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.eventId,
          row.identity_id,
          input.occurredAt,
          input.correlationId,
          JSON.stringify({ identityId: row.identity_id, documentId: row.id }),
        ],
      );
      await client.query('COMMIT');
      return targetVersions.length;
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

type RewrapDocumentRow = Omit<ProtectedDocumentRow, 'claim_state'>;

export interface DocumentKekRewrapInput {
  readonly documentId: string;
  readonly targetKekKeyVersion: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export class PostgresDocumentKekRewrapStore {
  readonly #pool: Pool;
  readonly #keyEncryptionProvider: KeyEncryptionProvider;
  readonly #targetProtector: NodeIdentityDocumentProtector;

  constructor(
    pool: Pool,
    keyEncryptionProvider: KeyEncryptionProvider,
    targetProtector: NodeIdentityDocumentProtector,
  ) {
    this.#pool = pool;
    this.#keyEncryptionProvider = keyEncryptionProvider;
    this.#targetProtector = targetProtector;
  }

  async rewrap(input: DocumentKekRewrapInput): Promise<'REWRAPPED' | 'REPLAY'> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RewrapDocumentRow>(
        `SELECT id, identity_id, country_code, issuer_code, document_type,
                normalization_profile, encryption_algorithm,
                encryption_schema_version, kek_key_version, ciphertext,
                nonce, authentication_tag, wrapped_dek
         FROM identity.identity_documents
         WHERE id = $1 AND state <> 'CRYPTOSHREDDED'
         FOR UPDATE`,
        [input.documentId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('REWRAP_DOCUMENT_UNAVAILABLE');
      const document = this.#asProtectedDocument(row);
      if (row.kek_key_version === input.targetKekKeyVersion) {
        await this.#targetProtector.verifyEnvelope(document);
        await client.query('COMMIT');
        return 'REPLAY';
      }

      const wrapped = await this.#keyEncryptionProvider.rewrap(
        row.wrapped_dek,
        row.kek_key_version,
      );
      if (wrapped.kekKeyVersion !== input.targetKekKeyVersion) {
        throw new Error('REWRAP_TARGET_KEY_MISMATCH');
      }
      const rewrappedDocument: ProtectedIdentityDocument = {
        ...document,
        envelope: {
          ...document.envelope,
          kekKeyVersion: wrapped.kekKeyVersion,
          wrappedDek: wrapped.wrappedDek,
        },
      };
      await this.#targetProtector.verifyEnvelope(rewrappedDocument);
      const updated = await client.query(
        `UPDATE identity.identity_documents
         SET kek_key_version = $2, wrapped_dek = $3, updated_at = $4
         WHERE id = $1 AND kek_key_version = $5`,
        [row.id, wrapped.kekKeyVersion, wrapped.wrappedDek, input.occurredAt, row.kek_key_version],
      );
      if (updated.rowCount !== 1) throw new Error('REWRAP_STALE_DOCUMENT');
      await client.query(
        `INSERT INTO platform.outbox_events (
           id, event_type, schema_version, aggregate_type, aggregate_id,
           occurred_at, correlation_id, payload
         ) VALUES ($1, 'identity.document_kek_rewrapped', 1,
           'identity', $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.eventId,
          row.identity_id,
          input.occurredAt,
          input.correlationId,
          JSON.stringify({ identityId: row.identity_id, documentId: row.id, state: 'REWRAPPED' }),
        ],
      );
      await client.query('COMMIT');
      return 'REWRAPPED';
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  #asProtectedDocument(row: RewrapDocumentRow): ProtectedIdentityDocument {
    return {
      context: {
        documentId: row.id,
        identityId: row.identity_id,
        countryCode: row.country_code,
        issuerCode: row.issuer_code,
        documentType: row.document_type,
        normalizationProfile: row.normalization_profile,
      },
      envelope: {
        algorithm: row.encryption_algorithm,
        schemaVersion: row.encryption_schema_version,
        kekKeyVersion: row.kek_key_version,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authenticationTag: row.authentication_tag,
        wrappedDek: row.wrapped_dek,
      },
      fingerprintAliases: [],
      requestCommitment: Buffer.alloc(32),
      requestCommitmentKeyVersion: 'rewrap-only',
    };
  }
}
