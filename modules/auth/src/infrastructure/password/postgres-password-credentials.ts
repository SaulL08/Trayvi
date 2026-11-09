import type { ClientContext } from '../../contracts/challenge';
import type { OutboxWriter } from '../../contracts/outbox';
import type {
  CompromisedPasswordChecker,
  PasswordCredentials,
  PasswordSetResult,
  PasswordVerifyResult,
} from '../../contracts/password';
import type { RateLimitDecision, RateLimiter, SubjectCommitter } from '../../contracts/rate-limit';
import type { IdGenerator, SqlExecutor } from '../../contracts/runtime';
import { normalizePassword } from '../../domain/password/password-policy';

import type { PasswordHash, ScryptPasswordHasher } from './scrypt-password-hasher';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type TransitionReason = 'SET' | 'CHANGED' | 'REHASH' | 'RECOVERY';

interface ActiveCredential {
  readonly id: string;
  readonly parameter_version: string;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

export class PasswordCredentialError extends Error {
  constructor() {
    super('PASSWORD_COMMAND_INVALID');
    this.name = 'PasswordCredentialError';
  }
}

export interface PostgresPasswordCredentialDependencies {
  readonly hasher: ScryptPasswordHasher;
  readonly checker: CompromisedPasswordChecker;
  readonly rateLimiter: RateLimiter;
  readonly subjects: SubjectCommitter;
  readonly ids: IdGenerator;
  readonly outbox: OutboxWriter;
}

function assertAccountId(accountId: string): void {
  if (!UUID.test(accountId)) throw new PasswordCredentialError();
}

/**
 * SPEC-002 ws-b PasswordCredentials over auth.password_credentials (migration 0018). Every method
 * runs on the caller's SqlExecutor; failure counting uses the autocommit rate limiter, so a
 * counted failure survives a caller rollback.
 */
export class PostgresPasswordCredentials implements PasswordCredentials {
  readonly #hasher: ScryptPasswordHasher;
  readonly #checker: CompromisedPasswordChecker;
  readonly #rateLimiter: RateLimiter;
  readonly #subjects: SubjectCommitter;
  readonly #ids: IdGenerator;
  readonly #outbox: OutboxWriter;

  constructor(dependencies: PostgresPasswordCredentialDependencies) {
    this.#hasher = dependencies.hasher;
    this.#checker = dependencies.checker;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#subjects = dependencies.subjects;
    this.#ids = dependencies.ids;
    this.#outbox = dependencies.outbox;
  }

  async hasActive(sql: SqlExecutor, accountId: string): Promise<boolean> {
    if (!UUID.test(accountId)) return false;
    const result = await sql.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM auth.password_credentials
         WHERE account_id = $1 AND state = 'ACTIVE'
       ) AS present`,
      [accountId],
    );
    return result.rows[0]?.present === true;
  }

  async verify(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly candidate: unknown;
      readonly client: ClientContext;
      readonly at: Date;
    },
  ): Promise<PasswordVerifyResult> {
    assertAccountId(command.accountId);
    const accountSubject = this.#subjects.commit('account', command.accountId);
    const networkSubject = command.client.networkCommitment;

    // R-13: an exhausted limit answers before any password is evaluated.
    const limited = this.#retryAfter([
      await this.#rateLimiter.peek('PASSWORD_FAILURE_ACCOUNT', accountSubject, command.at),
      await this.#rateLimiter.peek('PASSWORD_FAILURE_NETWORK_HOUR', networkSubject, command.at),
    ]);
    if (limited !== undefined) return { kind: 'RATE_LIMITED', retryAfterSeconds: limited };

    const active = await this.#lockActive(sql, command.accountId);
    if (!active) return { kind: 'NO_CREDENTIAL' };

    const normalized = normalizePassword(command.candidate);
    // Over-long candidates are mismatches without hashing; nothing longer was ever stored.
    const matched =
      normalized.ok &&
      (await this.#hasher.verify(normalized.value, {
        parameterVersion: active.parameter_version,
        salt: active.salt,
        hash: active.hash,
      }));
    if (!matched) {
      await this.#rateLimiter.consume('PASSWORD_FAILURE_ACCOUNT', accountSubject, command.at);
      await this.#rateLimiter.consume('PASSWORD_FAILURE_NETWORK_HOUR', networkSubject, command.at);
      return { kind: 'MISMATCH' };
    }

    if (normalized.ok && this.#hasher.needsRehash(active.parameter_version)) {
      const rehashed = await this.#hasher.hash(normalized.value);
      await this.#replace(sql, {
        accountId: command.accountId,
        previousId: active.id,
        next: rehashed,
        reason: 'REHASH',
        at: command.at,
        correlationId: this.#ids.uuidV7(),
      });
    }
    return { kind: 'MATCH' };
  }

  async set(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly password: unknown;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<PasswordSetResult> {
    assertAccountId(command.accountId);
    const normalized = normalizePassword(command.password);
    if (!normalized.ok) return { kind: 'REJECTED', reason: normalized.reason };
    if (await this.#checker.isCompromised(normalized.value)) {
      return { kind: 'REJECTED', reason: 'COMPROMISED' };
    }
    const next = await this.#hasher.hash(normalized.value);
    const active = await this.#lockActive(sql, command.accountId);
    const credentialId = await this.#replace(sql, {
      accountId: command.accountId,
      previousId: active?.id,
      next,
      reason: active ? 'CHANGED' : 'SET',
      at: command.at,
      correlationId: command.correlationId,
    });
    await this.#changed(sql, credentialId, command.accountId, active ? 'REPLACED' : 'SET', command);
    return { kind: 'SET' };
  }

  async remove(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly reason: 'RECOVERY';
      readonly caseId: string;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<void> {
    assertAccountId(command.accountId);
    if (command.reason !== 'RECOVERY' || !UUID.test(command.caseId)) {
      throw new PasswordCredentialError();
    }
    const active = await this.#lockActive(sql, command.accountId);
    if (!active) return;
    await this.#end(
      sql,
      active.id,
      command.accountId,
      'REMOVED',
      'RECOVERY',
      command.caseId,
      command,
    );
    await this.#changed(sql, active.id, command.accountId, 'REMOVED', command);
  }

  #retryAfter(decisions: readonly RateLimitDecision[]): number | undefined {
    const denied = decisions.filter(
      (decision): decision is Extract<RateLimitDecision, { allowed: false }> => !decision.allowed,
    );
    if (denied.length === 0) return undefined;
    return Math.max(...denied.map((decision) => decision.retryAfterSeconds));
  }

  async #lockActive(sql: SqlExecutor, accountId: string): Promise<ActiveCredential | undefined> {
    const result = await sql.query<ActiveCredential>(
      `SELECT id, parameter_version, salt, hash FROM auth.password_credentials
       WHERE account_id = $1 AND state = 'ACTIVE'
       FOR UPDATE`,
      [accountId],
    );
    return result.rows[0];
  }

  /** Ends the previous credential (if any) and inserts the next one; returns the new id. */
  async #replace(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly previousId: string | undefined;
      readonly next: PasswordHash;
      readonly reason: Exclude<TransitionReason, 'RECOVERY'>;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<string> {
    if (command.previousId) {
      await this.#end(
        sql,
        command.previousId,
        command.accountId,
        'REPLACED',
        command.reason,
        null,
        command,
      );
    }
    const credentialId = this.#ids.uuidV7();
    await sql.query(
      `INSERT INTO auth.password_credentials (
         id, account_id, algorithm, parameter_version, salt, hash, state, created_at
       ) VALUES ($1, $2, 'scrypt', $3, $4, $5, 'ACTIVE', $6)`,
      [
        credentialId,
        command.accountId,
        command.next.parameterVersion,
        command.next.salt,
        command.next.hash,
        command.at,
      ],
    );
    await this.#transition(sql, {
      credentialId,
      accountId: command.accountId,
      from: null,
      to: 'ACTIVE',
      reason: command.reason,
      caseId: null,
      at: command.at,
      correlationId: command.correlationId,
    });
    return credentialId;
  }

  async #end(
    sql: SqlExecutor,
    credentialId: string,
    accountId: string,
    to: 'REPLACED' | 'REMOVED',
    reason: TransitionReason,
    caseId: string | null,
    timing: { readonly at: Date; readonly correlationId: string },
  ): Promise<void> {
    await sql.query(
      `UPDATE auth.password_credentials SET state = $2, ended_at = $3
       WHERE id = $1 AND state = 'ACTIVE'`,
      [credentialId, to, timing.at],
    );
    await this.#transition(sql, {
      credentialId,
      accountId,
      from: 'ACTIVE',
      to,
      reason,
      caseId,
      at: timing.at,
      correlationId: timing.correlationId,
    });
  }

  async #transition(
    sql: SqlExecutor,
    row: {
      readonly credentialId: string;
      readonly accountId: string;
      readonly from: 'ACTIVE' | null;
      readonly to: 'ACTIVE' | 'REPLACED' | 'REMOVED';
      readonly reason: TransitionReason;
      readonly caseId: string | null;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<void> {
    await sql.query(
      `INSERT INTO auth.password_credential_transitions (
         id, credential_id, account_id, from_state, to_state, reason, case_id, occurred_at,
         correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        this.#ids.uuidV7(),
        row.credentialId,
        row.accountId,
        row.from,
        row.to,
        row.reason,
        row.caseId,
        row.at,
        row.correlationId,
      ],
    );
  }

  #changed(
    sql: SqlExecutor,
    credentialId: string,
    accountId: string,
    change: 'SET' | 'REPLACED' | 'REMOVED',
    timing: { readonly at: Date; readonly correlationId: string },
  ): Promise<void> {
    return this.#outbox.enqueue(sql, {
      id: this.#ids.uuidV7(),
      type: 'auth.password.changed',
      schemaVersion: 1,
      aggregateType: 'auth_credential',
      aggregateId: credentialId,
      occurredAt: timing.at,
      correlationId: timing.correlationId,
      payload: { accountId, change },
    });
  }
}
