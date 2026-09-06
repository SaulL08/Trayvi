import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';

import {
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  executeSqlFile,
} from '../../packages/test-support/src/index.js';
import { MigrationExecutionError, SqlMigrator } from './migrate.js';

export interface DatabaseVerificationEvidence {
  readonly postgis: boolean;
  readonly cleanApply: boolean;
  readonly repeatNoOp: boolean;
  readonly rollbackRollForward: boolean;
  readonly invalidMigrationRolledBack: boolean;
  readonly concurrentSerialized: boolean;
  readonly runtimeDdlDenied: boolean;
  readonly runtimeIdentityRestricted: boolean;
  readonly outboxAtomicity: boolean;
}

function quoteRuntimeIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier))
    throw new Error('Unsafe runtime role identifier.');
  return `"${identifier}"`;
}

async function verifyMainScenario(
  adminUrl: string,
): Promise<
  Omit<DatabaseVerificationEvidence, 'invalidMigrationRolledBack' | 'concurrentSerialized'>
> {
  const database = await createDisposableDatabase(adminUrl, 'trayvi_migration');
  const migrator = new SqlMigrator(database.url);
  const client = new Client({ connectionString: database.url });
  const runtimeLogin = await createRestrictedRuntimeLogin(adminUrl, database.url);
  const runtimeClient = new Client({ connectionString: runtimeLogin.url });
  try {
    const first = await migrator.up();
    const second = await migrator.up();
    await client.connect();
    const extension = await client.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS installed",
    );
    const table = await client.query<{ name: string | null }>(
      "SELECT to_regclass('platform.outbox_events')::text AS name",
    );

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO platform.outbox_events
       (id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at, correlation_id, payload)
       VALUES ($1, 'foundation.probe', 1, 'foundation', $2, clock_timestamp(), $3, '{}'::jsonb)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    await client.query('ROLLBACK');
    const afterRollback = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM platform.outbox_events',
    );
    await client.query(
      `INSERT INTO platform.outbox_events
       (id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at, correlation_id, payload)
       VALUES ($1, 'foundation.probe', 1, 'foundation', $2, clock_timestamp(), $3, '{}'::jsonb)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    const afterCommit = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM platform.outbox_events',
    );

    await runtimeClient.connect();
    const identity = await runtimeClient.query<{ session_user: string; current_user: string }>(
      'SELECT session_user, current_user',
    );
    const deniedStatements = [
      'CREATE TABLE platform.runtime_must_not_create (id integer)',
      'ALTER TABLE platform.outbox_events ADD COLUMN runtime_must_not_add integer',
      'DROP TABLE platform.outbox_events',
      'SET ROLE trayvi_local_admin',
      `GRANT trayvi_migrator TO ${quoteRuntimeIdentifier(runtimeLogin.name)}`,
    ];
    const denials: boolean[] = [];
    for (const statement of deniedStatements) {
      await runtimeClient.query('BEGIN');
      try {
        await runtimeClient.query(statement);
        denials.push(false);
      } catch {
        denials.push(true);
      } finally {
        await runtimeClient.query('ROLLBACK');
      }
    }
    const runtimeDdlDenied = denials.slice(0, 3).every(Boolean);
    const runtimeIdentityRestricted =
      identity.rows[0]?.session_user === runtimeLogin.name &&
      identity.rows[0]?.current_user === runtimeLogin.name &&
      denials.every(Boolean);

    const down = await migrator.down();
    const statusAfterDown = await migrator.status();
    const rollForward = await migrator.up();
    return {
      postgis: extension.rows[0]?.installed === true,
      cleanApply: first.applied.length === 1 && table.rows[0]?.name === 'platform.outbox_events',
      repeatNoOp: second.applied.length === 0 && second.skipped.length === 1,
      rollbackRollForward:
        down.length === 1 && statusAfterDown.length === 0 && rollForward.applied.length === 1,
      runtimeDdlDenied,
      runtimeIdentityRestricted,
      outboxAtomicity: afterRollback.rows[0]?.count === '0' && afterCommit.rows[0]?.count === '1',
    };
  } finally {
    await runtimeClient.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await migrator.close();
    await dropRestrictedRuntimeLogin(adminUrl, runtimeLogin.name).catch(() => undefined);
    await dropDisposableDatabase(adminUrl, database.name);
  }
}

async function verifyInvalidMigration(adminUrl: string): Promise<boolean> {
  const database = await createDisposableDatabase(adminUrl, 'trayvi_invalid');
  const migrator = new SqlMigrator(database.url, resolve('infra/database/fixtures/invalid'));
  try {
    let failed = false;
    try {
      await migrator.up();
    } catch (error: unknown) {
      failed = error instanceof MigrationExecutionError;
    }
    const status = await migrator.status();
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const table = await client.query<{ name: string | null }>(
        "SELECT to_regclass('public.deliberately_invalid_sql')::text AS name",
      );
      return failed && status.length === 0 && table.rows[0]?.name === null;
    } finally {
      await client.end();
    }
  } finally {
    await migrator.close();
    await dropDisposableDatabase(adminUrl, database.name);
  }
}

async function verifyConcurrency(adminUrl: string): Promise<boolean> {
  const database = await createDisposableDatabase(adminUrl, 'trayvi_concurrent');
  const first = new SqlMigrator(database.url);
  const second = new SqlMigrator(database.url);
  try {
    const results = await Promise.all([first.up(), second.up()]);
    const appliedCount = results.reduce((sum, result) => sum + result.applied.length, 0);
    const status = await first.status();
    return appliedCount === 1 && status.length === 1;
  } finally {
    await Promise.all([first.close(), second.close()]);
    await dropDisposableDatabase(adminUrl, database.name);
  }
}

export async function runDatabaseVerification(
  adminUrl: string,
): Promise<DatabaseVerificationEvidence> {
  const bootstrap = await readFile(resolve('infra/database/bootstrap/0001_roles.sql'), 'utf8');
  await executeSqlFile(adminUrl, bootstrap);
  const main = await verifyMainScenario(adminUrl);
  return {
    ...main,
    invalidMigrationRolledBack: await verifyInvalidMigration(adminUrl),
    concurrentSerialized: await verifyConcurrency(adminUrl),
  };
}
