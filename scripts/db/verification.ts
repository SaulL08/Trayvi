import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Client } from 'pg';

import {
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
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
  readonly outboxStateIntegrity: boolean;
  readonly outboxStateTransitions: boolean;
  readonly outboxImmutableDataDenied: boolean;
  readonly outboxMetadataMutationDenied: boolean;
  readonly outboxDeleteDenied: boolean;
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

    const contradictoryStates = [
      { status: 'processing', attempts: 1, locked: false, error: null },
      { status: 'pending', attempts: 0, locked: true, error: 'IMPOSSIBLE' },
    ] as const;
    const contradictoryStateDenials: boolean[] = [];
    for (const state of contradictoryStates) {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO platform.outbox_events
           (id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at,
            correlation_id, payload, status, attempts, locked_at, locked_by, last_error_code)
           VALUES ($1, 'foundation.invalid_state', 1, 'foundation', $2, clock_timestamp(),
             $3, '{}'::jsonb, $4, $5,
             CASE WHEN $6 THEN clock_timestamp() ELSE NULL END,
             CASE WHEN $6 THEN 'audit-worker' ELSE NULL END,
             $7)`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            state.status,
            state.attempts,
            state.locked,
            state.error,
          ],
        );
        contradictoryStateDenials.push(false);
      } catch {
        contradictoryStateDenials.push(true);
      } finally {
        await client.query('ROLLBACK');
      }
    }

    await runtimeClient.connect();
    const publishedId = randomUUID();
    const failedId = randomUUID();
    const newPendingParameters = (): readonly string[] => [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const insertPending = async (id: string): Promise<void> => {
      const [, aggregateId, correlationId] = newPendingParameters();
      await runtimeClient.query(
        `INSERT INTO platform.outbox_events
         (id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at,
          correlation_id, payload)
         VALUES ($1, 'foundation.transition_probe', 1, 'foundation', $2,
          clock_timestamp(), $3, '{}'::jsonb)`,
        [id, aggregateId, correlationId],
      );
    };
    await insertPending(publishedId);
    await runtimeClient.query(
      `UPDATE platform.outbox_events
       SET status = 'processing', attempts = attempts + 1,
           locked_at = clock_timestamp(), locked_by = 'verification-worker',
           published_at = NULL, last_error_code = NULL
       WHERE id = $1`,
      [publishedId],
    );
    await runtimeClient.query(
      `UPDATE platform.outbox_events
       SET status = 'published', locked_at = NULL, locked_by = NULL,
           published_at = clock_timestamp(), last_error_code = NULL
       WHERE id = $1`,
      [publishedId],
    );
    await insertPending(failedId);
    await runtimeClient.query(
      `UPDATE platform.outbox_events
       SET status = 'processing', attempts = attempts + 1,
           locked_at = clock_timestamp(), locked_by = 'verification-worker',
           published_at = NULL, last_error_code = NULL
       WHERE id = $1`,
      [failedId],
    );
    await runtimeClient.query(
      `UPDATE platform.outbox_events
       SET status = 'failed', locked_at = NULL, locked_by = NULL,
           published_at = NULL, last_error_code = 'DELIVERY_FAILED'
       WHERE id = $1`,
      [failedId],
    );
    await runtimeClient.query(
      `UPDATE platform.outbox_events
       SET status = 'processing', attempts = attempts + 1,
           locked_at = clock_timestamp(), locked_by = 'verification-worker-retry',
           published_at = NULL, last_error_code = NULL
       WHERE id = $1`,
      [failedId],
    );
    const allowedStateRows = await runtimeClient.query<{
      status: string;
      attempts: number;
      locked_at: Date | null;
      locked_by: string | null;
      published_at: Date | null;
      last_error_code: string | null;
    }>(
      `SELECT status, attempts, locked_at, locked_by, published_at, last_error_code
       FROM platform.outbox_events WHERE id IN ($1, $2) ORDER BY id`,
      [publishedId, failedId],
    );
    const publishedState = allowedStateRows.rows.find((row) => row.status === 'published');
    const retriedState = allowedStateRows.rows.find((row) => row.status === 'processing');
    const allowedTransitionsValid =
      publishedState?.attempts === 1 &&
      publishedState.locked_at === null &&
      publishedState.locked_by === null &&
      publishedState.published_at instanceof Date &&
      publishedState.last_error_code === null &&
      retriedState?.attempts === 2 &&
      retriedState.locked_at instanceof Date &&
      retriedState.locked_by === 'verification-worker-retry' &&
      retriedState.published_at === null &&
      retriedState.last_error_code === null;

    const skippedTransitions = [
      `UPDATE platform.outbox_events
       SET status = 'pending', attempts = 0, locked_at = NULL, locked_by = NULL,
           published_at = NULL, last_error_code = NULL WHERE id = '${publishedId}'`,
      `UPDATE platform.outbox_events
       SET status = 'processing', attempts = 2, locked_at = clock_timestamp(),
           locked_by = 'invalid-worker', published_at = NULL, last_error_code = NULL
       WHERE id = '${publishedId}'`,
    ];
    const pendingSkipId = randomUUID();
    await insertPending(pendingSkipId);
    skippedTransitions.push(
      `UPDATE platform.outbox_events
       SET status = 'published', attempts = 1, published_at = clock_timestamp(),
           locked_at = NULL, locked_by = NULL, last_error_code = NULL
       WHERE id = '${pendingSkipId}'`,
      `UPDATE platform.outbox_events
       SET status = 'failed', attempts = 1, published_at = NULL,
           locked_at = NULL, locked_by = NULL, last_error_code = 'SKIPPED_PROCESSING'
       WHERE id = '${pendingSkipId}'`,
      `INSERT INTO platform.outbox_events
       (id, event_type, schema_version, aggregate_type, aggregate_id, occurred_at,
        correlation_id, payload, status, attempts, published_at)
       VALUES ('${randomUUID()}', 'foundation.invalid_transition', 1, 'foundation',
        '${randomUUID()}', clock_timestamp(), '${randomUUID()}', '{}'::jsonb,
        'published', 1, clock_timestamp())`,
    );
    const skippedTransitionDenials: boolean[] = [];
    for (const statement of skippedTransitions) {
      await runtimeClient.query('BEGIN');
      try {
        await runtimeClient.query(statement);
        skippedTransitionDenials.push(false);
      } catch {
        skippedTransitionDenials.push(true);
      } finally {
        await runtimeClient.query('ROLLBACK');
      }
    }
    const outboxStateTransitions =
      allowedTransitionsValid &&
      skippedTransitionDenials.length === skippedTransitions.length &&
      skippedTransitionDenials.every(Boolean);

    const immutableStatements = [
      `UPDATE platform.outbox_events SET event_type = 'foundation.tampered' WHERE id = '${pendingSkipId}'`,
      `UPDATE platform.outbox_events SET payload = '{"tampered":true}'::jsonb WHERE id = '${pendingSkipId}'`,
    ];
    const immutableDataDenials: boolean[] = [];
    for (const statement of immutableStatements) {
      await runtimeClient.query('BEGIN');
      try {
        await runtimeClient.query(statement);
        immutableDataDenials.push(false);
      } catch {
        immutableDataDenials.push(true);
      } finally {
        await runtimeClient.query('ROLLBACK');
      }
    }
    const metadataStatements = [
      `UPDATE platform.outbox_events SET attempts = attempts + 100 WHERE id = '${failedId}'`,
      `UPDATE platform.outbox_events SET locked_by = 'tampered-worker' WHERE id = '${failedId}'`,
    ];
    const metadataMutationDenials: boolean[] = [];
    for (const statement of metadataStatements) {
      await runtimeClient.query('BEGIN');
      try {
        await runtimeClient.query(statement);
        metadataMutationDenials.push(false);
      } catch {
        metadataMutationDenials.push(true);
      } finally {
        await runtimeClient.query('ROLLBACK');
      }
    }

    const identity = await runtimeClient.query<{ session_user: string; current_user: string }>(
      'SELECT session_user, current_user',
    );
    const deniedStatements = [
      'CREATE TABLE platform.runtime_must_not_create (id integer)',
      'ALTER TABLE platform.outbox_events ADD COLUMN runtime_must_not_add integer',
      'DROP TABLE platform.outbox_events',
      'SET ROLE trayvi_local_admin',
      `GRANT trayvi_migrator TO ${quoteRuntimeIdentifier(runtimeLogin.name)}`,
      'DELETE FROM platform.outbox_events',
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
      denials.slice(0, 5).every(Boolean);
    const outboxDeleteDenied = denials[5] === true;

    const down = await migrator.down();
    const statusAfterDown = await migrator.status();
    const rollForward = await migrator.up();
    return {
      postgis: extension.rows[0]?.installed === true,
      cleanApply: first.applied.length === 7 && table.rows[0]?.name === 'platform.outbox_events',
      repeatNoOp: second.applied.length === 0 && second.skipped.length === 7,
      rollbackRollForward:
        down.length === 1 && statusAfterDown.length === 6 && rollForward.applied.length === 1,
      runtimeDdlDenied,
      runtimeIdentityRestricted,
      outboxAtomicity: afterRollback.rows[0]?.count === '0' && afterCommit.rows[0]?.count === '1',
      outboxStateIntegrity:
        contradictoryStateDenials.length === 2 && contradictoryStateDenials.every(Boolean),
      outboxStateTransitions,
      outboxImmutableDataDenied:
        immutableDataDenials.length === immutableStatements.length &&
        immutableDataDenials.every(Boolean),
      outboxMetadataMutationDenied:
        metadataMutationDenials.length === metadataStatements.length &&
        metadataMutationDenials.every(Boolean),
      outboxDeleteDenied,
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
    return appliedCount === 7 && status.length === 7;
  } finally {
    await Promise.all([first.close(), second.close()]);
    await dropDisposableDatabase(adminUrl, database.name);
  }
}

export async function runDatabaseVerification(
  adminUrl: string,
): Promise<DatabaseVerificationEvidence> {
  await ensureDatabaseBootstrap(adminUrl);
  const main = await verifyMainScenario(adminUrl);
  return {
    ...main,
    invalidMigrationRolledBack: await verifyInvalidMigration(adminUrl),
    concurrentSerialized: await verifyConcurrency(adminUrl),
  };
}
