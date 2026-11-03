import type { Pool } from 'pg';

import { assertDatabaseWorkload } from './database-workload';
import type {
  TrustedVerificationOutcome,
  TrustedVerificationRecord,
  TrustedVerificationStore,
} from './trusted-verification';

/**
 * Adapter for identity.record_trusted_verification. The pool's login must hold
 * trayvi_verification and no other workload role; use {@link PostgresTrustedVerificationStore.create}
 * to enforce that at wiring time.
 */
export class PostgresTrustedVerificationStore implements TrustedVerificationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  static async create(pool: Pool): Promise<PostgresTrustedVerificationStore> {
    await assertDatabaseWorkload(pool, 'trayvi_verification');
    return new PostgresTrustedVerificationStore(pool);
  }

  async recordTrustedVerification(
    input: TrustedVerificationRecord,
  ): Promise<TrustedVerificationOutcome> {
    if (input.evidenceDigest.byteLength !== 32) {
      throw new Error('INVALID_VERIFICATION_EVIDENCE');
    }
    const [identityEventId, accountEventId] = input.outboxEventIds;
    if (!identityEventId || !accountEventId || input.outboxEventIds.length !== 2) {
      throw new Error('OUTBOX_EVENT_SET_INVALID');
    }
    // One guarded command binds case, evidence, review, transitions, and the activation outbox
    // atomically.
    const result = await this.#pool.query<{ outcome: TrustedVerificationOutcome }>(
      `SELECT identity.record_trusted_verification(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
       ) AS outcome`,
      [
        input.decisionId,
        input.identityId,
        input.caseId,
        input.evidenceId,
        input.reviewId,
        input.identityTransitionId,
        input.accountTransitionId,
        identityEventId,
        accountEventId,
        input.methodClass,
        input.resultCode,
        input.policyVersion,
        input.providerAlias,
        input.evidenceType,
        input.evidenceDigest,
        input.restrictedEvidenceReference,
        input.retentionClass,
        input.actorReference,
        input.occurredAt,
        input.correlationId,
      ],
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome !== 'RECORDED' && outcome !== 'REPLAY') {
      throw new Error('VERIFICATION_OUTCOME_INVALID');
    }
    return outcome;
  }
}
