import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeInitializedDatabaseClients,
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '../../../../packages/test-support/src/index';

import { loadMigrationConfig, parseAuthConfig } from '../../../../packages/config/src/index';
import { SqlMigrator } from '../../../../scripts/db/migrate';
import type { ClientContext } from '../../src/contracts/challenge';
import type { IdGenerator, SqlExecutor } from '../../src/contracts/runtime';
import { PASSWORD_PARAMETER_VERSIONS } from '../../src/domain/password/password-policy';
import { RateLimitPolicy } from '../../src/domain/rate-limit/rate-limit-policy';
import { ListCompromisedPasswordChecker } from '../../src/infrastructure/password/compromised-password-checker';
import {
  PasswordCredentialError,
  PostgresPasswordCredentials,
} from '../../src/infrastructure/password/postgres-password-credentials';
import { ScryptPasswordHasher } from '../../src/infrastructure/password/scrypt-password-hasher';
import { PostgresRateLimiter } from '../../src/infrastructure/rate-limit/postgres-rate-limiter';
import { HmacSubjectCommitter } from '../../src/infrastructure/rate-limit/subject-committer';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';
import { PostgresOutboxWriter } from '../../src/infrastructure/shared/outbox-writer';

const uuidV7: IdGenerator = {
  uuidV7: () => {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Date.now(), 0, 6);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hexValue = bytes.toString('hex');
    return `${hexValue.slice(0, 8)}-${hexValue.slice(8, 12)}-${hexValue.slice(12, 16)}-${hexValue.slice(16, 20)}-${hexValue.slice(20)}`;
  },
};

const CHEAP_V0 = { cost: 1_024, blockSize: 8, parallelization: 1, keyLength: 32, saltLength: 16 };
const NETWORK_LIMIT = 8;

const subjects = new HmacSubjectCommitter(
  new ConfiguredAuthKeyring(
    (
      [
        ['auth-contact-fingerprint', 0x21],
        ['auth-contact-kek', 0x22],
        ['auth-otp-commitment', 0x23],
        ['auth-subject-commitment', 0x25],
      ] as const
    ).map(([purpose, byte]) => ({
      purpose,
      version: `${purpose}-v1`.replace('auth-', ''),
      state: 'PRIMARY' as const,
      material: Buffer.alloc(32, byte),
    })),
  ),
);

function executorOver(client: { query: Pool['query'] }): SqlExecutor {
  return {
    query: async <Row extends object>(text: string, values: readonly unknown[]) => {
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

async function inTransaction<T>(pool: Pool, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
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
}

const clientFrom = (network: string): ClientContext => ({
  installationCommitment: subjects.commit('installation', uuidV7.uuidV7()),
  networkCommitment: subjects.commit('network-prefix', network),
  correlationId: uuidV7.uuidV7(),
  locale: 'es-DO',
});

describe('password credentials on real PostgreSQL (SPEC-002 ws-b)', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  let admin: Pool;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtime: Pool;
  let credentials: PostgresPasswordCredentials;
  let legacy: PostgresPasswordCredentials;
  let network = 0;

  const at = () => new Date();
  const freshNetwork = () => `198.51.${(network += 1) % 250}.0/24`;

  const createAccount = async (): Promise<string> => {
    const accountId = uuidV7.uuidV7();
    await inTransaction(admin, async (sql) => {
      await sql.query(
        `INSERT INTO accounts.accounts (id, status, status_reason_code, version, created_at, updated_at)
         VALUES ($1, 'PENDING_IDENTITY', 'ENROLLMENT_STARTED', 0, clock_timestamp(), clock_timestamp())`,
        [accountId],
      );
      await sql.query(
        `INSERT INTO accounts.account_status_transitions (
           id, account_id, from_status, to_status, aggregate_version,
           actor_class, actor_reference, reason_code, evidence_reference, occurred_at
         ) VALUES ($1, $2, NULL, 'PENDING_IDENTITY', 0, 'ENROLLMENT_SERVICE',
           'auth-password-test', 'ENROLLMENT_STARTED', $3, clock_timestamp())`,
        [uuidV7.uuidV7(), accountId, uuidV7.uuidV7()],
      );
    });
    return accountId;
  };

  const set = (accountId: string, password: unknown, service = credentials) =>
    inTransaction(runtime, (sql) =>
      service.set(sql, { accountId, password, at: at(), correlationId: uuidV7.uuidV7() }),
    );
  const verify = (accountId: string, candidate: unknown, client = clientFrom(freshNetwork())) =>
    inTransaction(runtime, (sql) =>
      credentials.verify(sql, { accountId, candidate, client, at: at() }),
    );
  const rows = async (accountId: string) =>
    (
      await admin.query<{ state: string; parameter_version: string }>(
        `SELECT state, parameter_version FROM auth.password_credentials
         WHERE account_id = $1 ORDER BY created_at, id`,
        [accountId],
      )
    ).rows;
  const changes = async (accountId: string) =>
    (
      await admin.query<{ payload: { accountId: string; change: string } }>(
        `SELECT payload FROM platform.outbox_events
         WHERE event_type = 'auth.password.changed' AND payload->>'accountId' = $1
         ORDER BY occurred_at, id`,
        [accountId],
      )
    ).rows.map((row) => row.payload.change);

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_password');
    migrator = new SqlMigrator(database.url);
    await migrator.up();
    admin = new Pool({ connectionString: database.url, max: 4 });
    runtimeLogin = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    runtime = new Pool({ connectionString: runtimeLogin.url, max: 8 });
    const rules = parseAuthConfig(
      { AUTH_RATE_LIMIT_PASSWORD_FAILURE_NETWORK_HOUR: String(NETWORK_LIMIT) },
      'test',
    ).rateLimits;
    const rateLimiter = new PostgresRateLimiter(executorOver(runtime), new RateLimitPolicy(rules));
    const common = {
      checker: new ListCompromisedPasswordChecker(),
      rateLimiter,
      subjects,
      ids: uuidV7,
      outbox: new PostgresOutboxWriter(),
    };
    credentials = new PostgresPasswordCredentials({
      ...common,
      hasher: new ScryptPasswordHasher({
        versions: { ...PASSWORD_PARAMETER_VERSIONS, 'scrypt-v0': CHEAP_V0 },
        current: 'scrypt-v1',
        concurrency: 8,
      }),
    });
    legacy = new PostgresPasswordCredentials({
      ...common,
      hasher: new ScryptPasswordHasher({
        versions: { 'scrypt-v0': CHEAP_V0 },
        current: 'scrypt-v0',
        concurrency: 2,
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.end();
    if (runtimeLogin) await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, runtimeLogin.name);
    await closeInitializedDatabaseClients({ pool: admin, migrator });
    if (database) {
      await delay(50);
      await dropDisposableDatabase(adminConfig.databaseUrl, database.name);
    }
  });

  it('sets a scrypt-v1 credential, then replaces it, keeping one ACTIVE row (R-11, R-14)', async () => {
    const accountId = await createAccount();
    await expect(set(accountId, 'first strong phrase')).resolves.toEqual({ kind: 'SET' });
    await expect(set(accountId, 'second strong phrase')).resolves.toEqual({ kind: 'SET' });
    expect(await rows(accountId)).toEqual([
      { state: 'REPLACED', parameter_version: 'scrypt-v1' },
      { state: 'ACTIVE', parameter_version: 'scrypt-v1' },
    ]);
    expect(await changes(accountId)).toEqual(['SET', 'REPLACED']);
    await expect(verify(accountId, 'first strong phrase')).resolves.toEqual({ kind: 'MISMATCH' });
    await expect(verify(accountId, 'second strong phrase')).resolves.toEqual({ kind: 'MATCH' });
    const history = await admin.query<{
      from_state: string | null;
      to_state: string;
      reason: string;
    }>(
      `SELECT from_state, to_state, reason FROM auth.password_credential_transitions
       WHERE account_id = $1 ORDER BY occurred_at, to_state`,
      [accountId],
    );
    expect(history.rows).toHaveLength(3);
  }, 30_000);

  it('rejects short, long, and compromised passwords and writes nothing (R-12)', async () => {
    const accountId = await createAccount();
    await expect(set(accountId, 'short')).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'TOO_SHORT',
    });
    await expect(set(accountId, 'x'.repeat(129))).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'TOO_LONG',
    });
    await expect(set(accountId, 'Password1234')).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'COMPROMISED',
    });
    expect(await rows(accountId)).toEqual([]);
    expect(await changes(accountId)).toEqual([]);
  });

  it('matches NFC-equivalent spellings of the same password', async () => {
    const accountId = await createAccount();
    await set(accountId, 'mi contraseña larga');
    await expect(verify(accountId, 'mi contraseña larga')).resolves.toEqual({ kind: 'MATCH' });
  }, 30_000);

  it('answers NO_CREDENTIAL without an active password', async () => {
    const accountId = await createAccount();
    await expect(verify(accountId, 'anything at all here')).resolves.toEqual({
      kind: 'NO_CREDENTIAL',
    });
    await expect(
      inTransaction(runtime, (sql) => credentials.hasActive(sql, accountId)),
    ).resolves.toBe(false);
  });

  it('rehashes on a match under older parameters, without an event (R-11)', async () => {
    const accountId = await createAccount();
    await set(accountId, 'an old style password', legacy);
    expect(await rows(accountId)).toEqual([{ state: 'ACTIVE', parameter_version: 'scrypt-v0' }]);
    await expect(verify(accountId, 'wrong old password!!')).resolves.toEqual({ kind: 'MISMATCH' });
    expect((await rows(accountId)).at(-1)?.parameter_version).toBe('scrypt-v0');

    await expect(verify(accountId, 'an old style password')).resolves.toEqual({ kind: 'MATCH' });
    expect(await rows(accountId)).toEqual([
      { state: 'REPLACED', parameter_version: 'scrypt-v0' },
      { state: 'ACTIVE', parameter_version: 'scrypt-v1' },
    ]);
    expect(await changes(accountId)).toEqual(['SET']);
    await expect(verify(accountId, 'an old style password')).resolves.toEqual({ kind: 'MATCH' });
    expect(await rows(accountId)).toHaveLength(2);
  }, 30_000);

  it('stops evaluating after the per-account failure limit (R-13)', async () => {
    const accountId = await createAccount();
    await set(accountId, 'the right password');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verify(accountId, `wrong guess number ${attempt}`)).resolves.toEqual({
        kind: 'MISMATCH',
      });
    }
    const limited = await verify(accountId, 'the right password');
    expect(limited.kind).toBe('RATE_LIMITED');
    if (limited.kind === 'RATE_LIMITED') expect(limited.retryAfterSeconds).toBeGreaterThan(0);
  }, 60_000);

  it('stops evaluating after the per-network failure limit across accounts (R-13)', async () => {
    const client = clientFrom(freshNetwork());
    const accounts = [await createAccount(), await createAccount(), await createAccount()];
    for (const accountId of accounts) await set(accountId, 'the right password');
    let failures = 0;
    for (const accountId of accounts) {
      for (let attempt = 0; attempt < 3 && failures < NETWORK_LIMIT; attempt += 1) {
        await expect(verify(accountId, `wrong guess ${attempt}`, client)).resolves.toEqual({
          kind: 'MISMATCH',
        });
        failures += 1;
      }
    }
    const limited = await verify(accounts[2] ?? '', 'the right password', client);
    expect(limited.kind).toBe('RATE_LIMITED');
    // Another network is unaffected for an account that is under its own limit.
    await expect(verify(accounts[2] ?? '', 'the right password')).resolves.toEqual({
      kind: 'MATCH',
    });
  }, 60_000);

  it('removes the active credential for recovery with a REMOVED event', async () => {
    const accountId = await createAccount();
    await set(accountId, 'a password to remove');
    const caseId = uuidV7.uuidV7();
    await inTransaction(runtime, (sql) =>
      credentials.remove(sql, {
        accountId,
        reason: 'RECOVERY',
        caseId,
        at: at(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    expect(await rows(accountId)).toEqual([{ state: 'REMOVED', parameter_version: 'scrypt-v1' }]);
    expect(await changes(accountId)).toEqual(['SET', 'REMOVED']);
    const transition = await admin.query<{ case_id: string }>(
      "SELECT case_id FROM auth.password_credential_transitions WHERE account_id = $1 AND to_state = 'REMOVED'",
      [accountId],
    );
    expect(transition.rows[0]?.case_id).toBe(caseId);
    await expect(
      inTransaction(runtime, (sql) =>
        credentials.remove(sql, {
          accountId,
          reason: 'RECOVERY',
          caseId: 'nope',
          at: at(),
          correlationId: uuidV7.uuidV7(),
        }),
      ),
    ).rejects.toBeInstanceOf(PasswordCredentialError);
  }, 30_000);

  it('enforces one ACTIVE credential, immutable hashes, and no deletes in PostgreSQL (R-14)', async () => {
    const accountId = await createAccount();
    await set(accountId, 'only one is active');
    await expect(
      admin.query(
        `INSERT INTO auth.password_credentials (id, account_id, algorithm, parameter_version, salt, hash, state, created_at)
         VALUES ($1, $2, 'scrypt', 'scrypt-v1', decode(repeat('00', 16), 'hex'), decode(repeat('00', 32), 'hex'), 'ACTIVE', now())`,
        [uuidV7.uuidV7(), accountId],
      ),
    ).rejects.toMatchObject({ constraint: 'password_credential_one_active_per_account' });
    for (const statement of [
      "UPDATE auth.password_credentials SET hash = decode(repeat('11', 32), 'hex') WHERE account_id = $1",
      'DELETE FROM auth.password_credentials WHERE account_id = $1',
      "UPDATE auth.password_credential_transitions SET reason = 'SET' WHERE account_id = $1",
    ]) {
      await expect(admin.query(statement, [accountId])).rejects.toMatchObject({ code: '23514' });
    }
    for (const statement of [
      "UPDATE auth.password_credentials SET salt = decode(repeat('11', 16), 'hex') WHERE account_id = $1",
      'DELETE FROM auth.password_credentials WHERE account_id = $1',
      'DELETE FROM auth.password_credential_transitions WHERE account_id = $1',
    ]) {
      await expect(runtime.query(statement, [accountId])).rejects.toMatchObject({ code: '42501' });
    }
  }, 30_000);

  it('refuses to roll back migration 0018 while credentials exist', async () => {
    const versions = (await migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0018').reverse()) {
      expect(await migrator.down()).toEqual([version]);
    }
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0018');
    await migrator.up();
  });
});
