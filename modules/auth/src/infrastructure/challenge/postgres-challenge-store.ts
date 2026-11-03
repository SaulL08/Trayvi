import type { ChallengePurpose, ChallengeState } from '../../contracts/challenge';
import type { SqlExecutor } from '../../contracts/runtime';
import type {
  ChallengeRecord,
  ChallengeStore,
  DeliveryOutcomeCode,
  NewChallengeRecord,
  NewProofRecord,
  ProofRecord,
} from '../../application/challenge/ports';

interface ChallengeRow {
  readonly id: string;
  readonly purpose: ChallengePurpose;
  readonly destination_key_version: string;
  readonly destination_fingerprint: Buffer;
  readonly otp_commitment: Buffer;
  readonly otp_key_version: string;
  readonly installation_commitment: Buffer;
  readonly failed_attempts: number;
  readonly max_failed_attempts: number;
  readonly resend_count: number;
  readonly max_resends: number;
  readonly last_sent_at: Date;
  readonly expires_at: Date;
  readonly state: ChallengeState;
}

interface ProofRow {
  readonly id: string;
  readonly challenge_id: string;
  readonly challenge_state: ChallengeState;
  readonly purpose: ChallengePurpose;
  readonly destination_key_version: string;
  readonly destination_fingerprint: Buffer;
  readonly installation_commitment: Buffer;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

/** PostgreSQL ChallengeStore over migration 0014; runs as trayvi_runtime on the caller's executor. */
export class PostgresChallengeStore implements ChallengeStore {
  async cancelPending(
    sql: SqlExecutor,
    purpose: ChallengePurpose,
    destinationKeyVersion: string,
    destinationFingerprint: Buffer,
    at: Date,
  ): Promise<number> {
    const result = await sql.query(
      `UPDATE auth.verification_challenges
       SET state = 'CANCELLED', updated_at = $4
       WHERE purpose = $1 AND destination_key_version = $2 AND destination_fingerprint = $3
         AND state = 'PENDING'`,
      [purpose, destinationKeyVersion, destinationFingerprint, at],
    );
    return result.rowCount;
  }

  async insert(sql: SqlExecutor, record: NewChallengeRecord): Promise<boolean> {
    // ON CONFLICT on the PENDING partial index waits for a concurrent winner instead of aborting
    // the transaction, so the caller can cancel it and retry.
    const result = await sql.query<{ id: string }>(
      `INSERT INTO auth.verification_challenges (
         id, purpose, destination_key_version, destination_fingerprint, otp_commitment,
         otp_key_version, installation_commitment, failed_attempts, max_failed_attempts,
         resend_count, max_resends, last_sent_at, expires_at, state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 0, $9, $10, $11, 'PENDING', $12, $12)
       ON CONFLICT (purpose, destination_key_version, destination_fingerprint)
         WHERE state = 'PENDING' DO NOTHING
       RETURNING id`,
      [
        record.id,
        record.purpose,
        record.destinationKeyVersion,
        record.destinationFingerprint,
        record.otpCommitment,
        record.otpKeyVersion,
        record.installationCommitment,
        record.maxFailedAttempts,
        record.maxResends,
        record.lastSentAt,
        record.expiresAt,
        record.createdAt,
      ],
    );
    return result.rows.length === 1;
  }

  async lock(sql: SqlExecutor, challengeId: string): Promise<ChallengeRecord | undefined> {
    const result = await sql.query<ChallengeRow>(
      `SELECT id, purpose, destination_key_version, destination_fingerprint, otp_commitment,
              otp_key_version, installation_commitment, failed_attempts, max_failed_attempts,
              resend_count, max_resends, last_sent_at, expires_at, state
       FROM auth.verification_challenges
       WHERE id = $1
       FOR UPDATE`,
      [challengeId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      purpose: row.purpose,
      destinationKeyVersion: row.destination_key_version,
      destinationFingerprint: row.destination_fingerprint,
      otpCommitment: row.otp_commitment,
      otpKeyVersion: row.otp_key_version,
      installationCommitment: row.installation_commitment,
      failedAttempts: row.failed_attempts,
      maxFailedAttempts: row.max_failed_attempts,
      resendCount: row.resend_count,
      maxResends: row.max_resends,
      lastSentAt: row.last_sent_at,
      expiresAt: row.expires_at,
      state: row.state,
    };
  }

  async transition(
    sql: SqlExecutor,
    challengeId: string,
    from: ChallengeState,
    to: ChallengeState,
    at: Date,
  ): Promise<boolean> {
    const result = await sql.query(
      `UPDATE auth.verification_challenges SET state = $3, updated_at = $4
       WHERE id = $1 AND state = $2`,
      [challengeId, from, to, at],
    );
    return result.rowCount === 1;
  }

  async recordResend(
    sql: SqlExecutor,
    challengeId: string,
    otpCommitment: Buffer,
    otpKeyVersion: string,
    at: Date,
  ): Promise<boolean> {
    const result = await sql.query(
      `UPDATE auth.verification_challenges
       SET otp_commitment = $2, otp_key_version = $3, resend_count = resend_count + 1,
           last_sent_at = $4, delivery_outcome_code = NULL, updated_at = $4
       WHERE id = $1 AND state = 'PENDING' AND resend_count < max_resends`,
      [challengeId, otpCommitment, otpKeyVersion, at],
    );
    return result.rowCount === 1;
  }

  async recordFailure(
    sql: SqlExecutor,
    challengeId: string,
    at: Date,
  ): Promise<{ readonly failedAttempts: number; readonly state: ChallengeState } | undefined> {
    // One statement: the increment and the exhaustion edge cannot be observed apart.
    const result = await sql.query<{ failed_attempts: number; state: ChallengeState }>(
      `UPDATE auth.verification_challenges
       SET failed_attempts = failed_attempts + 1,
           state = CASE WHEN failed_attempts + 1 >= max_failed_attempts THEN 'EXHAUSTED' ELSE state END,
           updated_at = $2
       WHERE id = $1 AND state = 'PENDING' AND failed_attempts < max_failed_attempts
       RETURNING failed_attempts, state`,
      [challengeId, at],
    );
    const row = result.rows[0];
    return row ? { failedAttempts: row.failed_attempts, state: row.state } : undefined;
  }

  async recordDeliveryOutcome(
    sql: SqlExecutor,
    challengeId: string,
    outcome: DeliveryOutcomeCode,
    at: Date,
  ): Promise<void> {
    await sql.query(
      `UPDATE auth.verification_challenges SET delivery_outcome_code = $2, updated_at = $3
       WHERE id = $1`,
      [challengeId, outcome, at],
    );
  }

  async insertProof(sql: SqlExecutor, proof: NewProofRecord): Promise<void> {
    await sql.query(
      `INSERT INTO auth.contact_proofs (
         id, challenge_id, purpose, destination_key_version, destination_fingerprint,
         proof_hash, installation_commitment, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        proof.id,
        proof.challengeId,
        proof.purpose,
        proof.destinationKeyVersion,
        proof.destinationFingerprint,
        proof.proofHash,
        proof.installationCommitment,
        proof.createdAt,
        proof.expiresAt,
      ],
    );
  }

  async lockProof(sql: SqlExecutor, proofHash: Buffer): Promise<ProofRecord | undefined> {
    const result = await sql.query<ProofRow>(
      `SELECT proof.id, proof.challenge_id, challenge.state AS challenge_state, proof.purpose,
              proof.destination_key_version, proof.destination_fingerprint,
              proof.installation_commitment, proof.expires_at, proof.consumed_at
       FROM auth.contact_proofs proof
       JOIN auth.verification_challenges challenge ON challenge.id = proof.challenge_id
       WHERE proof.proof_hash = $1
       FOR UPDATE OF proof, challenge`,
      [proofHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      challengeId: row.challenge_id,
      challengeState: row.challenge_state,
      purpose: row.purpose,
      destinationKeyVersion: row.destination_key_version,
      destinationFingerprint: row.destination_fingerprint,
      installationCommitment: row.installation_commitment,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? undefined,
    };
  }

  async consumeProof(
    sql: SqlExecutor,
    proofId: string,
    challengeId: string,
    at: Date,
  ): Promise<boolean> {
    const proof = await sql.query(
      `UPDATE auth.contact_proofs SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [proofId, at],
    );
    if (proof.rowCount !== 1) return false;
    const challenge = await sql.query(
      `UPDATE auth.verification_challenges SET state = 'CONSUMED', updated_at = $2
       WHERE id = $1 AND state = 'VERIFIED'`,
      [challengeId, at],
    );
    if (challenge.rowCount !== 1) throw new Error('CONTACT_PROOF_CHALLENGE_STALE');
    return true;
  }
}
