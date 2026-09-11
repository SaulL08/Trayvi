import { timingSafeEqual } from 'node:crypto';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { transitionAccount } from '@trayvi/accounts';
import { transitionIdentity } from '@trayvi/identity';

import type {
  EnrollmentMutationProbe,
  PhaseOneEnrollmentStore,
  StartEnrollmentRecord,
  StartEnrollmentStoreResult,
  SubmitEnrollmentRecord,
  SubmitEnrollmentStoreResult,
  TrustedVerificationRecord,
} from './phase-one-enrollment';

const noOpProbe: EnrollmentMutationProbe = {
  checkpoint: () => Promise.resolve(),
};

function sameBuffer(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

interface OperationRow {
  readonly submission_commitment: Buffer | null;
  readonly submission_commitment_key_version: string | null;
  readonly state: 'STARTED' | 'COMPLETED' | 'CONFLICT' | 'EXPIRED';
  readonly expired: boolean;
}

export class PostgresPhaseOneStore implements PhaseOneEnrollmentStore {
  readonly #pool: Pool;
  readonly #probe: EnrollmentMutationProbe;

  constructor(pool: Pool, probe: EnrollmentMutationProbe = noOpProbe) {
    this.#pool = pool;
    this.#probe = probe;
  }

  async start(input: StartEnrollmentRecord): Promise<StartEnrollmentStoreResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO accounts.account_creation_operations (
           id, caller_binding_commitment, idempotency_key_commitment,
           request_commitment, request_commitment_key_version, state,
           safe_result_code, created_at, updated_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'STARTED', 'ACCOUNT_CREATION_ACCEPTED', $6, $6, $7)
         ON CONFLICT (caller_binding_commitment, idempotency_key_commitment) DO NOTHING
         RETURNING id`,
        [
          input.operationId,
          input.callerBindingCommitment,
          input.idempotencyKeyCommitment,
          input.requestCommitment,
          input.requestCommitmentKeyVersion,
          input.createdAt,
          input.expiresAt,
        ],
      );
      if ((inserted.rowCount ?? 0) === 1) {
        await client.query('COMMIT');
        return { kind: 'ACCEPTED', operationId: input.operationId, submitted: false };
      }

      const existing = await client.query<{
        id: string;
        request_commitment: Buffer;
        request_commitment_key_version: string;
        state: string;
      }>(
        `SELECT id, request_commitment, request_commitment_key_version, state
         FROM accounts.account_creation_operations
         WHERE caller_binding_commitment = $1 AND idempotency_key_commitment = $2
         FOR UPDATE`,
        [input.callerBindingCommitment, input.idempotencyKeyCommitment],
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.request_commitment_key_version !== input.requestCommitmentKeyVersion ||
        !sameBuffer(row.request_commitment, input.requestCommitment)
      ) {
        await client.query('ROLLBACK');
        return { kind: 'IDEMPOTENCY_CONFLICT' };
      }
      await client.query('COMMIT');
      return { kind: 'ACCEPTED', operationId: row.id, submitted: row.state !== 'STARTED' };
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async submit(input: SubmitEnrollmentRecord): Promise<SubmitEnrollmentStoreResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const operation = await this.#lockOperation(client, input.operationId);
      if (!operation) {
        await client.query('ROLLBACK');
        return { kind: 'UNAVAILABLE' };
      }
      if (operation.submission_commitment) {
        if (
          operation.submission_commitment_key_version !==
            input.protectedDocument.requestCommitmentKeyVersion ||
          !sameBuffer(operation.submission_commitment, input.protectedDocument.requestCommitment)
        ) {
          await client.query('ROLLBACK');
          return { kind: 'IDEMPOTENCY_CONFLICT' };
        }
        if (operation.state === 'COMPLETED' || operation.state === 'CONFLICT') {
          await client.query('COMMIT');
          return { kind: 'ACCEPTED' };
        }
      }
      if (operation.state !== 'STARTED' || operation.expired) {
        if (operation.state === 'STARTED' && operation.expired) {
          await client.query(
            `UPDATE accounts.account_creation_operations
             SET submission_commitment = $2,
                 submission_commitment_key_version = $3,
                 state = 'EXPIRED',
                 safe_result_code = 'IDENTITY_SUBMISSION_ACCEPTED',
                 safe_internal_code = 'OPERATION_EXPIRED',
                 updated_at = $4
             WHERE id = $1`,
            [
              input.operationId,
              input.protectedDocument.requestCommitment,
              input.protectedDocument.requestCommitmentKeyVersion,
              input.occurredAt,
            ],
          );
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
        return { kind: 'UNAVAILABLE' };
      }

      await this.#insertPendingAggregate(client, input);
      await client.query(
        `UPDATE accounts.account_creation_operations
         SET submission_commitment = $2,
             submission_commitment_key_version = $3,
             state = 'COMPLETED',
             safe_result_code = 'IDENTITY_SUBMISSION_ACCEPTED',
             safe_internal_code = NULL,
             account_id = $4,
             updated_at = $5
         WHERE id = $1 AND state = 'STARTED'`,
        [
          input.operationId,
          input.protectedDocument.requestCommitment,
          input.protectedDocument.requestCommitmentKeyVersion,
          input.accountId,
          input.occurredAt,
        ],
      );
      await this.#probe.checkpoint('IDEMPOTENCY_RESULT_RECORDED');
      await client.query('COMMIT');
      return { kind: 'ACCEPTED' };
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isConstraint(error, 'document_fingerprint_blocking_unique')) {
        await this.#recordDuplicateConflict(client, input);
        return { kind: 'ACCEPTED' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTrustedVerification(
    input: TrustedVerificationRecord,
  ): Promise<'RECORDED' | 'REPLAY'> {
    if (input.evidenceDigest.byteLength !== 32) {
      throw new Error('INVALID_VERIFICATION_EVIDENCE');
    }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity.verification_cases
         WHERE decision_id = $1 FOR UPDATE`,
        [input.decisionId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].identity_id !== input.identityId) {
          throw new Error('VERIFICATION_DECISION_REUSE');
        }
        await client.query('COMMIT');
        return 'REPLAY';
      }

      const aggregate = await client.query<{
        identity_id: string;
        identity_status: 'PENDING' | 'ESTABLISHED' | 'RESTRICTED' | 'RETIRED';
        identity_version: number;
        account_id: string;
        account_status: 'PENDING_IDENTITY' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';
        account_version: number;
      }>(
        `SELECT person_identity.id AS identity_id,
                person_identity.status AS identity_status,
                person_identity.version AS identity_version,
                account.id AS account_id,
                account.status AS account_status,
                account.version AS account_version
         FROM identity.person_identities person_identity
         JOIN accounts.accounts account ON account.id = person_identity.account_id
         WHERE person_identity.id = $1
         FOR UPDATE OF person_identity, account`,
        [input.identityId],
      );
      const row = aggregate.rows[0];
      if (!row || row.identity_status !== 'PENDING' || row.account_status !== 'PENDING_IDENTITY') {
        throw new Error('VERIFICATION_TARGET_UNAVAILABLE');
      }

      await client.query(
        `INSERT INTO identity.verification_cases (
           id, identity_id, method_class, status, policy_version, opened_at, expires_at
         ) VALUES ($1, $2, $3, 'PENDING', $4, $5, $6)`,
        [
          input.caseId,
          input.identityId,
          input.methodClass,
          input.policyVersion,
          input.occurredAt,
          new Date(input.occurredAt.getTime() + 15 * 60 * 1_000),
        ],
      );
      await client.query(
        `INSERT INTO identity.verification_evidence (
           id, case_id, evidence_type, provider_alias, collected_at,
           digest_algorithm, evidence_digest, restricted_reference,
           retention_class, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'sha-256', $6, $7, $8, $5)`,
        [
          input.evidenceId,
          input.caseId,
          input.evidenceType,
          input.providerAlias,
          input.occurredAt,
          input.evidenceDigest,
          input.restrictedEvidenceReference,
          input.retentionClass,
        ],
      );
      await client.query(
        `INSERT INTO identity.identity_reviews (
           id, case_id, state, actor_class, actor_reference, reason_code,
           evidence_reference, policy_version, created_at, updated_at, resolved_at
         ) VALUES ($1, $2, 'NOT_REQUIRED', 'POLICY_ENGINE', $3,
           'TRUSTED_VERIFICATION_ACCEPTED', $4, $5, $6, $6, $6)`,
        [
          input.reviewId,
          input.caseId,
          input.actorReference,
          input.evidenceId,
          input.policyVersion,
          input.occurredAt,
        ],
      );
      await client.query(
        `UPDATE identity.verification_cases
         SET decision_id = $2, status = 'VERIFIED', result_code = $3, resolved_at = $4
         WHERE id = $1 AND status = 'PENDING'`,
        [input.caseId, input.decisionId, input.resultCode, input.occurredAt],
      );
      const bound = await client.query(
        `UPDATE identity.document_fingerprint_claims claim
         SET state = 'BOUND', bound_at = $2
         FROM identity.identity_documents document
         WHERE claim.document_id = document.id
           AND document.identity_id = $1
           AND document.state = 'CURRENT'
           AND claim.state = 'RESERVED'`,
        [input.identityId, input.occurredAt],
      );
      if ((bound.rowCount ?? 0) === 0) throw new Error('VERIFICATION_CLAIM_MISSING');

      const identity = transitionIdentity(
        { id: row.identity_id, status: row.identity_status, version: row.identity_version },
        {
          to: 'ESTABLISHED',
          expectedVersion: row.identity_version,
          actorClass: 'TRUSTED_VERIFICATION_HANDLER',
          actorReference: input.actorReference,
          reasonCode: 'IDENTITY_ESTABLISHED',
          evidenceReference: input.evidenceId,
          occurredAt: input.occurredAt,
        },
        {
          verificationCaseStatus: 'VERIFIED',
          reviewStatus: 'NOT_REQUIRED',
          documentClaimStatus: 'BOUND',
        },
      );
      await client.query(
        `UPDATE identity.person_identities
         SET status = 'ESTABLISHED', status_reason_code = 'IDENTITY_ESTABLISHED',
             version = $2, updated_at = $3, established_at = $3
         WHERE id = $1 AND version = $4`,
        [input.identityId, identity.version, input.occurredAt, row.identity_version],
      );
      await client.query(
        `INSERT INTO identity.identity_status_transitions (
           id, identity_id, from_status, to_status, aggregate_version,
           actor_class, actor_reference, reason_code, evidence_reference, occurred_at
         ) VALUES ($1, $2, 'PENDING', 'ESTABLISHED', $3,
           'TRUSTED_VERIFICATION_HANDLER', $4, 'IDENTITY_ESTABLISHED', $5, $6)`,
        [
          input.identityTransitionId,
          input.identityId,
          identity.version,
          input.actorReference,
          input.evidenceId,
          input.occurredAt,
        ],
      );

      const account = transitionAccount(
        { id: row.account_id, status: row.account_status, version: row.account_version },
        {
          to: 'ACTIVE',
          expectedVersion: row.account_version,
          actorClass: 'TRUSTED_VERIFICATION_HANDLER',
          actorReference: input.actorReference,
          reasonCode: 'IDENTITY_ESTABLISHED',
          evidenceReference: input.evidenceId,
          occurredAt: input.occurredAt,
        },
        { identityEstablished: true, documentClaimBound: true },
      );
      await client.query(
        `UPDATE accounts.accounts
         SET status = 'ACTIVE', status_reason_code = 'IDENTITY_ESTABLISHED',
             version = $2, updated_at = $3
         WHERE id = $1 AND version = $4`,
        [row.account_id, account.version, input.occurredAt, row.account_version],
      );
      await client.query(
        `INSERT INTO accounts.account_status_transitions (
           id, account_id, from_status, to_status, aggregate_version,
           actor_class, actor_reference, reason_code, evidence_reference, occurred_at
         ) VALUES ($1, $2, 'PENDING_IDENTITY', 'ACTIVE', $3,
           'TRUSTED_VERIFICATION_HANDLER', $4, 'IDENTITY_ESTABLISHED', $5, $6)`,
        [
          input.accountTransitionId,
          row.account_id,
          account.version,
          input.actorReference,
          input.evidenceId,
          input.occurredAt,
        ],
      );
      await this.#insertOutbox(
        client,
        input.outboxEventIds[0],
        'identity.established',
        'identity',
        input.identityId,
        input.occurredAt,
        input.correlationId,
        input.decisionId,
        { identityId: input.identityId, accountId: row.account_id, state: 'ESTABLISHED' },
      );
      await this.#insertOutbox(
        client,
        input.outboxEventIds[1],
        'account.activated',
        'account',
        row.account_id,
        input.occurredAt,
        input.correlationId,
        input.decisionId,
        { accountId: row.account_id, state: 'ACTIVE' },
      );
      await client.query('COMMIT');
      return 'RECORDED';
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockOperation(client: PoolClient, operationId: string): Promise<OperationRow | undefined> {
    const result = await client.query<OperationRow>(
      `SELECT submission_commitment, submission_commitment_key_version, state,
              expires_at <= clock_timestamp() AS expired
       FROM accounts.account_creation_operations
       WHERE id = $1
       FOR UPDATE`,
      [operationId],
    );
    return result.rows[0];
  }

  async #insertPendingAggregate(client: PoolClient, input: SubmitEnrollmentRecord): Promise<void> {
    const { context, envelope, fingerprintAliases } = input.protectedDocument;
    await client.query(
      `INSERT INTO accounts.accounts (
         id, status, status_reason_code, version, created_at, updated_at
       ) VALUES ($1, 'PENDING_IDENTITY', 'ENROLLMENT_STARTED', 0, $2, $2)`,
      [input.accountId, input.occurredAt],
    );
    await this.#probe.checkpoint('ACCOUNT_INSERTED');
    await client.query(
      `INSERT INTO identity.person_identities (
         id, account_id, status, status_reason_code, version, created_at, updated_at
       ) VALUES ($1, $2, 'PENDING', 'VERIFICATION_PENDING', 0, $3, $3)`,
      [input.identityId, input.accountId, input.occurredAt],
    );
    await this.#probe.checkpoint('IDENTITY_INSERTED');
    await client.query(
      `INSERT INTO identity.identity_documents (
         id, identity_id, country_code, issuer_code, document_type,
         normalization_profile, encryption_algorithm, encryption_schema_version,
         kek_key_version, ciphertext, nonce, authentication_tag, wrapped_dek,
         state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'CURRENT', $14, $14)`,
      [
        input.documentId,
        input.identityId,
        context.countryCode,
        context.issuerCode,
        context.documentType,
        context.normalizationProfile,
        envelope.algorithm,
        envelope.schemaVersion,
        envelope.kekKeyVersion,
        envelope.ciphertext,
        envelope.nonce,
        envelope.authenticationTag,
        envelope.wrappedDek,
        input.occurredAt,
      ],
    );
    await this.#probe.checkpoint('DOCUMENT_ENVELOPE_INSERTED');
    if (input.claimIds.length !== fingerprintAliases.length || fingerprintAliases.length === 0) {
      throw new Error('FINGERPRINT_ALIAS_SET_INVALID');
    }
    for (const [index, alias] of fingerprintAliases.entries()) {
      await client.query(
        `INSERT INTO identity.document_fingerprint_claims (
           id, document_id, country_code, issuer_code, document_type,
           normalization_profile, hmac_algorithm, hmac_key_version,
           fingerprint, state, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RESERVED', $10)`,
        [
          input.claimIds[index],
          input.documentId,
          context.countryCode,
          context.issuerCode,
          context.documentType,
          context.normalizationProfile,
          alias.algorithm,
          alias.keyVersion,
          alias.fingerprint,
          input.occurredAt,
        ],
      );
    }
    await this.#probe.checkpoint('FINGERPRINT_CLAIMS_INSERTED');
    await client.query(
      `INSERT INTO accounts.account_status_transitions (
         id, account_id, from_status, to_status, aggregate_version,
         actor_class, actor_reference, reason_code, evidence_reference, occurred_at
       ) VALUES ($1, $2, NULL, 'PENDING_IDENTITY', 0,
         'ENROLLMENT_SERVICE', 'phase-one-enrollment', 'ENROLLMENT_STARTED', $3, $4)`,
      [input.accountTransitionId, input.accountId, input.operationId, input.occurredAt],
    );
    await client.query(
      `INSERT INTO identity.identity_status_transitions (
         id, identity_id, from_status, to_status, aggregate_version,
         actor_class, actor_reference, reason_code, evidence_reference, occurred_at
       ) VALUES ($1, $2, NULL, 'PENDING', 0,
         'ENROLLMENT_SERVICE', 'phase-one-enrollment', 'VERIFICATION_PENDING', $3, $4)`,
      [input.identityTransitionId, input.identityId, input.operationId, input.occurredAt],
    );
    await this.#probe.checkpoint('TRANSITION_HISTORY_INSERTED');

    const events = [
      {
        id: input.outboxEventIds[0],
        type: 'identity.created',
        aggregateType: 'identity',
        aggregateId: input.identityId,
        payload: { identityId: input.identityId, accountId: input.accountId, state: 'PENDING' },
      },
      {
        id: input.outboxEventIds[1],
        type: 'identity.document_claimed',
        aggregateType: 'identity',
        aggregateId: input.identityId,
        payload: { identityId: input.identityId, documentId: input.documentId },
      },
      {
        id: input.outboxEventIds[2],
        type: 'identity.linked_to_account',
        aggregateType: 'identity',
        aggregateId: input.identityId,
        payload: { identityId: input.identityId, accountId: input.accountId },
      },
    ] as const;
    for (const event of events) {
      await this.#insertOutbox(
        client,
        event.id,
        event.type,
        event.aggregateType,
        event.aggregateId,
        input.occurredAt,
        input.correlationId,
        input.causationId,
        event.payload,
      );
    }
    await this.#probe.checkpoint('OUTBOX_INSERTED');
  }

  async #recordDuplicateConflict(client: PoolClient, input: SubmitEnrollmentRecord): Promise<void> {
    await client.query(
      `UPDATE accounts.account_creation_operations
       SET submission_commitment = $2,
           submission_commitment_key_version = $3,
           state = 'CONFLICT',
           safe_result_code = 'IDENTITY_SUBMISSION_ACCEPTED',
           safe_internal_code = 'CLAIM_RACE_LOST',
           updated_at = $4
       WHERE id = $1 AND state = 'STARTED'`,
      [
        input.operationId,
        input.protectedDocument.requestCommitment,
        input.protectedDocument.requestCommitmentKeyVersion,
        input.occurredAt,
      ],
    );
  }

  async #insertOutbox(
    client: PoolClient,
    eventId: string | undefined,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: Date,
    correlationId: string,
    causationId: string | undefined,
    payload: Readonly<Record<string, string>>,
  ): Promise<QueryResult> {
    if (!eventId) throw new Error('OUTBOX_EVENT_SET_INVALID');
    return client.query(
      `INSERT INTO platform.outbox_events (
         id, event_type, schema_version, aggregate_type, aggregate_id,
         occurred_at, correlation_id, causation_id, payload
       ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        eventId,
        eventType,
        aggregateType,
        aggregateId,
        occurredAt,
        correlationId,
        causationId ?? null,
        JSON.stringify(payload),
      ],
    );
  }
}
