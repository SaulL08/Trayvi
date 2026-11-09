import type { AuthOutboxEvent, OutboxWriter } from '../../contracts/outbox';
import type { Clock, IdGenerator, SqlExecutor, TransactionRunner } from '../../contracts/runtime';
import type {
  AccessTokenResolution,
  AccessTokenResolver,
  AccountSessionRevoker,
  AssuranceLevel,
  AuthFactor,
  FamilyRevokeReason,
  IssuedSession,
  IssueSessionCommand,
  RefreshResult,
  SessionCommands,
  SessionFamilySummary,
  SessionPolicy,
} from '../../contracts/session';
import type { OpaqueTokenCodec } from '../../contracts/tokens';
import {
  assuranceFor,
  canonicalFactors,
  familyExpiry,
  validateSessionPolicy,
} from '../../domain/session/session-policy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMITMENT_BYTES = 32;

/** Reasons a caller may revoke with; REUSE_DETECTED is reserved for the rotation command. */
type CallerRevokeReason = Exclude<FamilyRevokeReason, 'REUSE_DETECTED'>;

export class SessionCommandError extends Error {
  constructor(
    code: 'SESSION_ACCOUNT_NOT_ELIGIBLE' | 'SESSION_COMMAND_INVALID' | 'SESSION_FAMILY_NOT_ACTIVE',
  ) {
    super(code);
    this.name = 'SessionCommandError';
  }
}

export interface PostgresSessionDependencies {
  readonly policy: SessionPolicy;
  readonly codec: OpaqueTokenCodec;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly outbox: OutboxWriter;
  /** Runs `refresh`, which owns its transaction. */
  readonly transactions: TransactionRunner;
  /** Autocommit reads: access-token resolution and family listing. */
  readonly reader: SqlExecutor;
}

type RotationOutcome =
  'ROTATED' | 'GRACE_ROTATED' | 'REUSE_DETECTED' | 'ACCOUNT_STATE' | 'EXPIRED' | 'INVALID';

function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1_000);
}

function isCommitment(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.byteLength === COMMITMENT_BYTES;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isAccountNotEligible(error: unknown): boolean {
  return error instanceof Error && error.message === 'SESSION_ACCOUNT_NOT_ELIGIBLE';
}

/**
 * SPEC-002 ws-a session commands over the guarded `auth` functions (migration 0017). Tokens are
 * returned once and only their SHA-256 hashes reach PostgreSQL (PLAN §9.1).
 */
export class PostgresSessionCommands
  implements SessionCommands, AccountSessionRevoker, AccessTokenResolver
{
  readonly #policy: SessionPolicy;
  readonly #codec: OpaqueTokenCodec;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #outbox: OutboxWriter;
  readonly #transactions: TransactionRunner;
  readonly #reader: SqlExecutor;

  constructor(dependencies: PostgresSessionDependencies) {
    this.#policy = validateSessionPolicy(dependencies.policy);
    this.#codec = dependencies.codec;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#outbox = dependencies.outbox;
    this.#transactions = dependencies.transactions;
    this.#reader = dependencies.reader;
  }

  async issue(sql: SqlExecutor, command: IssueSessionCommand): Promise<IssuedSession> {
    const factors = canonicalFactors(command.factors);
    if (
      !factors ||
      !isUuid(command.accountId) ||
      !isCommitment(command.installationCommitment) ||
      Number.isNaN(command.authenticatedAt.getTime())
    ) {
      throw new SessionCommandError('SESSION_COMMAND_INVALID');
    }
    const at = this.#clock.now();
    const assurance = assuranceFor(factors);
    const familyId = this.#ids.uuidV7();
    const sessionId = this.#ids.uuidV7();
    const access = this.#codec.issue('tva_');
    const refresh = this.#codec.issue('tvr_');
    const accessTokenExpiresAt = addSeconds(at, this.#policy.accessTokenSeconds);
    const idleExpiresAt = addSeconds(at, this.#policy.idleSeconds);
    const absoluteExpiresAt = addSeconds(at, this.#policy.absoluteSeconds);

    let newInstallation: boolean;
    try {
      const result = await sql.query<{ new_installation: boolean }>(
        `SELECT auth.issue_session_family(
           $1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13, $14
         ) AS new_installation`,
        [
          familyId,
          sessionId,
          this.#ids.uuidV7(),
          command.accountId,
          command.installationCommitment,
          factors,
          assurance,
          command.authenticatedAt,
          access.hash,
          accessTokenExpiresAt,
          refresh.hash,
          idleExpiresAt,
          absoluteExpiresAt,
          at,
        ],
      );
      newInstallation = result.rows[0]?.new_installation === true;
    } catch (error: unknown) {
      if (isAccountNotEligible(error))
        throw new SessionCommandError('SESSION_ACCOUNT_NOT_ELIGIBLE');
      throw error;
    }

    await this.#enqueue(sql, 'auth.session.created', familyId, at, command.correlationId, {
      familyId,
      accountId: command.accountId,
      assurance,
      newInstallation,
    });
    return {
      familyId,
      sessionId,
      accessToken: access.token,
      accessTokenExpiresAt,
      refreshToken: refresh.token,
      familyExpiresAt: familyExpiry(idleExpiresAt, absoluteExpiresAt),
      newInstallation,
    };
  }

  async refresh(command: {
    readonly refreshToken: unknown;
    readonly installationCommitment: Buffer;
    readonly at: Date;
    readonly correlationId: string;
  }): Promise<RefreshResult> {
    const presentedHash = this.#codec.hash('tvr_', command.refreshToken);
    if (!presentedHash || !isCommitment(command.installationCommitment)) {
      return { kind: 'REAUTHENTICATION_REQUIRED' };
    }
    const at = command.at;
    const sessionId = this.#ids.uuidV7();
    const access = this.#codec.issue('tva_');
    const refresh = this.#codec.issue('tvr_');
    const accessTokenExpiresAt = addSeconds(at, this.#policy.accessTokenSeconds);

    return this.#transactions.inTransaction(async (sql) => {
      const result = await sql.query<{
        outcome: RotationOutcome;
        family_id: string | null;
        account_id: string | null;
        family_expires_at: Date | null;
      }>(
        `SELECT outcome, family_id, account_id, family_expires_at
         FROM auth.rotate_refresh_token($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          presentedHash,
          command.installationCommitment,
          at,
          this.#policy.rotationGraceSeconds,
          this.#policy.idleSeconds,
          sessionId,
          access.hash,
          accessTokenExpiresAt,
          this.#ids.uuidV7(),
          refresh.hash,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('SESSION_ROTATION_RESULT_MISSING');
      const { outcome, family_id: familyId, account_id: accountId } = row;

      if (
        (outcome === 'ROTATED' || outcome === 'GRACE_ROTATED') &&
        familyId &&
        row.family_expires_at
      ) {
        return {
          kind: 'ROTATED',
          session: {
            familyId,
            sessionId,
            accessToken: access.token,
            accessTokenExpiresAt,
            refreshToken: refresh.token,
            familyExpiresAt: row.family_expires_at,
            newInstallation: false,
          },
        };
      }
      if (outcome === 'REUSE_DETECTED' && familyId && accountId) {
        await this.#enqueue(
          sql,
          'auth.session.reuse_detected',
          familyId,
          at,
          command.correlationId,
          {
            familyId,
            accountId,
          },
        );
        await this.#revokedEvent(
          sql,
          familyId,
          accountId,
          'REUSE_DETECTED',
          at,
          command.correlationId,
        );
      } else if (outcome === 'ACCOUNT_STATE' && familyId && accountId) {
        await this.#revokedEvent(
          sql,
          familyId,
          accountId,
          'ACCOUNT_STATE',
          at,
          command.correlationId,
        );
      }
      return { kind: 'REAUTHENTICATION_REQUIRED' };
    });
  }

  async revokeFamily(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly familyId: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<{ readonly kind: 'REVOKED' | 'NOT_FOUND' }> {
    if (!isUuid(command.accountId) || !isUuid(command.familyId)) return { kind: 'NOT_FOUND' };
    const revoked = await this.#revoke(sql, {
      accountId: command.accountId,
      familyId: command.familyId,
      exceptFamilyId: null,
      reason: this.#callerReason(command.reason),
      at: command.at,
      correlationId: command.correlationId,
    });
    return { kind: revoked === 1 ? 'REVOKED' : 'NOT_FOUND' };
  }

  async revokeAllForAccount(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly exceptFamilyId?: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<number> {
    if (!isUuid(command.accountId)) throw new SessionCommandError('SESSION_COMMAND_INVALID');
    if (command.exceptFamilyId !== undefined && !isUuid(command.exceptFamilyId)) {
      throw new SessionCommandError('SESSION_COMMAND_INVALID');
    }
    return this.#revoke(sql, {
      accountId: command.accountId,
      familyId: null,
      exceptFamilyId: command.exceptFamilyId ?? null,
      reason: this.#callerReason(command.reason),
      at: command.at,
      correlationId: command.correlationId,
    });
  }

  async recordStepUp(
    sql: SqlExecutor,
    command: { readonly familyId: string; readonly factor: AuthFactor; readonly at: Date },
  ): Promise<void> {
    if (!isUuid(command.familyId) || !canonicalFactors([command.factor])) {
      throw new SessionCommandError('SESSION_COMMAND_INVALID');
    }
    const result = await sql.query<{ recorded: boolean }>(
      'SELECT auth.record_step_up($1, $2, $3) AS recorded',
      [command.familyId, command.factor, command.at],
    );
    if (result.rows[0]?.recorded !== true) {
      throw new SessionCommandError('SESSION_FAMILY_NOT_ACTIVE');
    }
  }

  async listFamilies(
    accountId: string,
    currentFamilyId: string,
  ): Promise<readonly SessionFamilySummary[]> {
    if (!isUuid(accountId)) return [];
    const result = await this.#reader.query<{
      id: string;
      created_at: Date;
      last_rotated_at: Date;
      assurance: AssuranceLevel;
    }>(
      `SELECT family.id, family.created_at, family.last_rotated_at, family.assurance
       FROM auth.session_families family
       WHERE family.account_id = $1 AND family.state = 'ACTIVE'
         AND family.idle_expires_at > $2 AND family.absolute_expires_at > $2
       ORDER BY family.created_at DESC, family.id DESC`,
      [accountId, this.#clock.now()],
    );
    return result.rows.map((row) => ({
      familyId: row.id,
      createdAt: row.created_at,
      lastRotatedAt: row.last_rotated_at,
      assurance: row.assurance,
      current: row.id === currentFamilyId,
    }));
  }

  async resolve(accessToken: unknown, at: Date): Promise<AccessTokenResolution> {
    const hash = this.#codec.hash('tva_', accessToken);
    if (!hash || Number.isNaN(at.getTime())) return { kind: 'INVALID' };
    const result = await this.#reader.query<{
      account_id: string;
      session_id: string;
      family_id: string;
      authenticated_at: Date;
      assurance: AssuranceLevel;
      factors: AuthFactor[];
    }>(
      `SELECT account_id, session_id, family_id, authenticated_at, assurance, factors
       FROM auth.resolve_access_token($1, $2)`,
      [hash, at],
    );
    const row = result.rows[0];
    if (!row) return { kind: 'INVALID' };
    return {
      kind: 'ACTIVE',
      accountId: row.account_id,
      sessionId: row.session_id,
      familyId: row.family_id,
      authenticatedAt: row.authenticated_at,
      assurance: row.assurance,
      factors: Object.freeze([...row.factors]),
    };
  }

  #callerReason(reason: FamilyRevokeReason): CallerRevokeReason {
    if (reason === 'REUSE_DETECTED') throw new SessionCommandError('SESSION_COMMAND_INVALID');
    return reason;
  }

  async #revoke(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly familyId: string | null;
      readonly exceptFamilyId: string | null;
      readonly reason: CallerRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<number> {
    const result = await sql.query<{ family_id: string }>(
      'SELECT family_id FROM auth.revoke_session_families($1, $2, $3, $4, $5)',
      [command.accountId, command.familyId, command.exceptFamilyId, command.reason, command.at],
    );
    for (const row of result.rows) {
      await this.#revokedEvent(
        sql,
        row.family_id,
        command.accountId,
        command.reason,
        command.at,
        command.correlationId,
      );
    }
    return result.rows.length;
  }

  #revokedEvent(
    sql: SqlExecutor,
    familyId: string,
    accountId: string,
    reason: FamilyRevokeReason,
    at: Date,
    correlationId: string,
  ): Promise<void> {
    return this.#enqueue(sql, 'auth.session.family_revoked', familyId, at, correlationId, {
      familyId,
      accountId,
      reason,
    });
  }

  #enqueue(
    sql: SqlExecutor,
    type: Extract<AuthOutboxEvent['type'], `auth.session.${string}`>,
    familyId: string,
    occurredAt: Date,
    correlationId: string,
    payload: AuthOutboxEvent['payload'],
  ): Promise<void> {
    return this.#outbox.enqueue(sql, {
      id: this.#ids.uuidV7(),
      type,
      schemaVersion: 1,
      aggregateType: 'auth_session',
      aggregateId: familyId,
      occurredAt,
      correlationId,
      payload,
    });
  }
}
