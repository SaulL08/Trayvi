import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import {
  closeInitializedDatabaseClients,
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '../../../../packages/test-support/src/index';

import { loadMigrationConfig } from '../../../../packages/config/src/index';
import { SqlMigrator } from '../../../../scripts/db/migrate';
import type { IdGenerator, SqlExecutor, TransactionRunner } from '../../src/contracts/runtime';
import type { IssuedSession, SessionPolicy } from '../../src/contracts/session';
import { PostgresSessionCommands } from '../../src/infrastructure/session/postgres-sessions';
import { NodeOpaqueTokenCodec } from '../../src/infrastructure/shared/opaque-token-codec';
import { PostgresOutboxWriter } from '../../src/infrastructure/shared/outbox-writer';

/** RFC 9562 UUIDv7 for test identifiers (production composes the observability generator). */
export const uuidV7: IdGenerator = {
  uuidV7: () => {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Date.now(), 0, 6);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hexValue = bytes.toString('hex');
    return `${hexValue.slice(0, 8)}-${hexValue.slice(8, 12)}-${hexValue.slice(12, 16)}-${hexValue.slice(16, 20)}-${hexValue.slice(20)}`;
  },
};

export const POLICY: SessionPolicy = {
  accessTokenSeconds: 600,
  idleSeconds: 86_400,
  absoluteSeconds: 172_800,
  rotationGraceSeconds: 30,
  recentAuthSeconds: 300,
};

export const installation = (): Buffer => randomBytes(32);

export function seconds(at: Date, value: number): Date {
  return new Date(at.getTime() + value * 1_000);
}

function executorOver(client: { query: Pool['query'] }): SqlExecutor {
  return {
    query: async <Row extends object>(text: string, values: readonly unknown[]) => {
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

export function transactionsOver(pool: Pool): TransactionRunner {
  return {
    async inTransaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await work(executorOver(client));
        await client.query('COMMIT');
        return value;
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface SessionHarness {
  /** Superuser pool for fixtures and assertions only. */
  readonly admin: Pool;
  /** Restricted trayvi_runtime login, as the API uses. */
  readonly runtime: Pool;
  readonly migrator: SqlMigrator;
  readonly clock: { at: Date; now(): Date };
  readonly sessions: PostgresSessionCommands;
  readonly transactions: TransactionRunner;
  createAccount(status?: string): Promise<string>;
  setAccountStatus(accountId: string, status: string): Promise<void>;
  issue(
    accountId: string,
    device?: Buffer,
    factors?: readonly ('CONTACT_OTP' | 'PASSWORD')[],
  ): Promise<IssuedSession>;
  close(): Promise<void>;
}

export async function createSessionHarness(runtimeConnections = 12): Promise<SessionHarness> {
  const adminConfig = loadMigrationConfig();
  await ensureDatabaseBootstrap(adminConfig.databaseUrl);
  const database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_session');
  const migrator = new SqlMigrator(database.url);
  await migrator.up();
  const admin = new Pool({ connectionString: database.url, max: 4 });
  const login = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
  const runtime = new Pool({
    connectionString: login.url,
    max: runtimeConnections,
    statement_timeout: 30_000,
  });
  const clock = {
    at: new Date('2026-11-09T12:00:00.000Z'),
    now() {
      return this.at;
    },
  };
  const transactions = transactionsOver(runtime);
  const sessions = new PostgresSessionCommands({
    policy: POLICY,
    codec: new NodeOpaqueTokenCodec(),
    ids: uuidV7,
    clock,
    outbox: new PostgresOutboxWriter(),
    transactions,
    reader: executorOver(runtime),
  });

  const adminTransactions = transactionsOver(admin);
  const transition = async (
    sql: SqlExecutor,
    accountId: string,
    from: string | null,
    to: string,
    version: number,
  ) => {
    await sql.query(
      `INSERT INTO accounts.account_status_transitions (
         id, account_id, from_status, to_status, aggregate_version,
         actor_class, actor_reference, reason_code, evidence_reference, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, 'ENROLLMENT_SERVICE', 'auth-session-test', 'TEST_FIXTURE', $6, clock_timestamp())`,
      [uuidV7.uuidV7(), accountId, from, to, version, uuidV7.uuidV7()],
    );
  };

  return {
    admin,
    runtime,
    migrator,
    clock,
    sessions,
    transactions,
    async createAccount() {
      const accountId = uuidV7.uuidV7();
      await adminTransactions.inTransaction(async (sql) => {
        await sql.query(
          `INSERT INTO accounts.accounts (id, status, status_reason_code, version, created_at, updated_at)
           VALUES ($1, 'PENDING_IDENTITY', 'ENROLLMENT_STARTED', 0, clock_timestamp(), clock_timestamp())`,
          [accountId],
        );
        await transition(sql, accountId, null, 'PENDING_IDENTITY', 0);
      });
      return accountId;
    },
    async setAccountStatus(accountId, status) {
      // Fixture only: bypasses the Phase 1 lifecycle guards as a superuser in a replica session.
      await adminTransactions.inTransaction(async (sql) => {
        await sql.query("SET LOCAL session_replication_role = 'replica'", []);
        await sql.query(
          `UPDATE accounts.accounts
           SET status = $2::varchar,
               closed_at = CASE WHEN $2::varchar = 'CLOSED' THEN clock_timestamp() END
           WHERE id = $1`,
          [accountId, status],
        );
      });
    },
    issue(accountId, device = installation(), factors = ['CONTACT_OTP']) {
      return transactions.inTransaction((sql) =>
        sessions.issue(sql, {
          accountId,
          installationCommitment: device,
          factors,
          authenticatedAt: clock.now(),
          correlationId: uuidV7.uuidV7(),
        }),
      );
    },
    async close() {
      await runtime.end();
      await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, login.name);
      await closeInitializedDatabaseClients({ pool: admin, migrator });
      await delay(50);
      await dropDisposableDatabase(adminConfig.databaseUrl, database.name);
    },
  };
}
