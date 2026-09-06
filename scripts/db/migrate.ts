import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { ConfigValidationError, loadMigrationConfig } from '../../packages/config/src/index.js';
import type { DatabaseTlsConfig } from '../../packages/config/src/index.js';

const MIGRATION_LOCK_ID = '84932675001377';
const DEFAULT_MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'infra/database/migrations');

interface MigrationDefinition {
  readonly version: string;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly upChecksum: string;
  readonly downChecksum: string;
  readonly pairChecksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly upChecksum: string;
  readonly downChecksum: string;
  readonly pairChecksum: string;
  readonly appliedAt: Date;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export class MigrationExecutionError extends Error {
  constructor(version: string, operation: 'up' | 'down') {
    super(`Migration ${version} failed during ${operation}; the transaction was rolled back.`);
    this.name = 'MigrationExecutionError';
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function pairChecksum(upChecksum: string, downChecksum: string): string {
  return checksum(`${upChecksum}:${downChecksum}`);
}

async function loadMigrations(directory: string): Promise<readonly MigrationDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const upFiles = entries
    .filter((entry) => entry.isFile() && /^\d{4,}_[a-z0-9_]+\.up\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const downFiles = entries
    .filter((entry) => entry.isFile() && /^\d{4,}_[a-z0-9_]+\.down\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const definitions: MigrationDefinition[] = [];
  for (const upFile of upFiles) {
    const match = /^(\d{4,})_([a-z0-9_]+)\.up\.sql$/u.exec(upFile);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid migration filename: ${upFile}`);
    const downFile = `${match[1]}_${match[2]}.down.sql`;
    const upSql = await readFile(resolve(directory, upFile), 'utf8');
    let downSql: string;
    try {
      downSql = await readFile(resolve(directory, downFile), 'utf8');
    } catch {
      throw new Error(`Migration ${match[1]} has no paired down SQL file.`);
    }
    const upChecksum = checksum(upSql);
    const downChecksum = checksum(downSql);
    definitions.push({
      version: match[1],
      name: match[2],
      upSql,
      downSql,
      upChecksum,
      downChecksum,
      pairChecksum: pairChecksum(upChecksum, downChecksum),
    });
  }

  const versions = definitions.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length)
    throw new Error('Migration versions must be unique.');
  const expectedDownFiles = upFiles.map((file) => file.replace(/\.up\.sql$/u, '.down.sql'));
  if (expectedDownFiles.join('\n') !== downFiles.join('\n')) {
    throw new Error('Migration up/down files must form exact pairs.');
  }
  return definitions;
}

function assertExactHistory(
  applied: readonly AppliedMigration[],
  definitions: readonly MigrationDefinition[],
): void {
  if (applied.length > definitions.length) {
    throw new Error('Applied migration history is not a valid repository prefix.');
  }
  for (const [index, existing] of applied.entries()) {
    const expected = definitions[index];
    if (
      !expected ||
      existing.version !== expected.version ||
      existing.name !== expected.name ||
      existing.upChecksum !== expected.upChecksum ||
      existing.downChecksum !== expected.downChecksum ||
      existing.pairChecksum !== expected.pairChecksum
    ) {
      throw new Error('Applied migration history is not a valid repository prefix.');
    }
  }
}

async function initializeMetadata(
  client: PoolClient,
  definitions: readonly MigrationDefinition[],
): Promise<void> {
  await client.query('BEGIN');
  try {
    const table = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.trayvi_schema_migrations') IS NOT NULL AS exists",
    );
    if (table.rows[0]?.exists !== true) {
      await client.query(`
        CREATE TABLE public.trayvi_schema_migrations (
          version varchar(32) PRIMARY KEY,
          name varchar(160) NOT NULL,
          up_checksum char(64) NOT NULL,
          down_checksum char(64) NOT NULL,
          pair_checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
    } else {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trayvi_schema_migrations'
         ORDER BY column_name`,
      );
      const actual = columns.rows.map((row) => row.column_name);
      const legacy = ['applied_at', 'checksum', 'name', 'version'];
      const current = [
        'applied_at',
        'down_checksum',
        'name',
        'pair_checksum',
        'up_checksum',
        'version',
      ];
      if (actual.join('\n') === legacy.join('\n')) {
        const oldRows = await client.query<{
          version: string;
          name: string;
          checksum: string;
        }>('SELECT version, name, checksum FROM public.trayvi_schema_migrations ORDER BY version');
        if (oldRows.rows.length > definitions.length) {
          throw new Error('Legacy migration history is not a valid repository prefix.');
        }
        for (const [index, row] of oldRows.rows.entries()) {
          const expected = definitions[index];
          if (
            !expected ||
            row.version !== expected.version ||
            row.name !== expected.name ||
            row.checksum !== expected.upChecksum
          ) {
            throw new Error('Legacy migration history is not a valid repository prefix.');
          }
        }
        await client.query(
          'ALTER TABLE public.trayvi_schema_migrations RENAME checksum TO up_checksum',
        );
        await client.query(
          'ALTER TABLE public.trayvi_schema_migrations ADD COLUMN down_checksum char(64)',
        );
        await client.query(
          'ALTER TABLE public.trayvi_schema_migrations ADD COLUMN pair_checksum char(64)',
        );
        for (const row of oldRows.rows) {
          const expected = definitions.find((migration) => migration.version === row.version);
          if (!expected)
            throw new Error('Legacy migration history is not a valid repository prefix.');
          await client.query(
            `UPDATE public.trayvi_schema_migrations
             SET down_checksum = $2, pair_checksum = $3
             WHERE version = $1`,
            [row.version, expected.downChecksum, expected.pairChecksum],
          );
        }
        await client.query(
          'ALTER TABLE public.trayvi_schema_migrations ALTER COLUMN down_checksum SET NOT NULL',
        );
        await client.query(
          'ALTER TABLE public.trayvi_schema_migrations ALTER COLUMN pair_checksum SET NOT NULL',
        );
      } else if (actual.join('\n') !== current.join('\n')) {
        throw new Error('Migration metadata schema is incomplete or unsupported.');
      }
    }
    await client.query('REVOKE ALL ON TABLE public.trayvi_schema_migrations FROM PUBLIC');
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function readApplied(client: PoolClient): Promise<readonly AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    up_checksum: string;
    down_checksum: string;
    pair_checksum: string;
    applied_at: Date;
  }>(
    `SELECT version, name, up_checksum, down_checksum, pair_checksum, applied_at
     FROM public.trayvi_schema_migrations
     ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    upChecksum: row.up_checksum,
    downChecksum: row.down_checksum,
    pairChecksum: row.pair_checksum,
    appliedAt: row.applied_at,
  }));
}

export class SqlMigrator {
  readonly #pool: Pool;
  readonly #directory: string;

  constructor(
    databaseUrl: string,
    migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
    databaseTls: DatabaseTlsConfig = { mode: 'disable' },
  ) {
    this.#directory = migrationsDirectory;
    this.#pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      max: 2,
      ssl:
        databaseTls.mode === 'verify-full'
          ? {
              rejectUnauthorized: databaseTls.rejectUnauthorized,
              ...(databaseTls.ca ? { ca: databaseTls.ca } : {}),
            }
          : false,
      statement_timeout: 30_000,
    });
  }

  async up(): Promise<MigrationRunResult> {
    const definitions = await loadMigrations(this.#directory);
    return this.#withLock(async (client) => {
      await initializeMetadata(client, definitions);
      const applied = await readApplied(client);
      assertExactHistory(applied, definitions);
      const result: { applied: string[]; skipped: string[] } = { applied: [], skipped: [] };

      for (const [index, migration] of definitions.entries()) {
        if (index < applied.length) {
          result.skipped.push(migration.version);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(migration.upSql);
          await client.query(
            `INSERT INTO public.trayvi_schema_migrations
               (version, name, up_checksum, down_checksum, pair_checksum)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              migration.version,
              migration.name,
              migration.upChecksum,
              migration.downChecksum,
              migration.pairChecksum,
            ],
          );
          await client.query('COMMIT');
          result.applied.push(migration.version);
        } catch {
          await client.query('ROLLBACK');
          throw new MigrationExecutionError(migration.version, 'up');
        }
      }
      return result;
    });
  }

  async down(): Promise<readonly string[]> {
    const definitions = await loadMigrations(this.#directory);
    return this.#withLock(async (client) => {
      await initializeMetadata(client, definitions);
      const applied = await readApplied(client);
      assertExactHistory(applied, definitions);
      const latest = applied.at(-1);
      if (!latest) return [];
      const migration = definitions[applied.length - 1];
      if (!migration)
        throw new Error('Applied migration history is not a valid repository prefix.');
      await client.query('BEGIN');
      try {
        await client.query(migration.downSql);
        await client.query('DELETE FROM public.trayvi_schema_migrations WHERE version = $1', [
          migration.version,
        ]);
        await client.query('COMMIT');
        return [migration.version];
      } catch {
        await client.query('ROLLBACK');
        throw new MigrationExecutionError(migration.version, 'down');
      }
    });
  }

  async status(): Promise<readonly AppliedMigration[]> {
    return this.#withLock(async (client) => {
      const definitions = await loadMigrations(this.#directory);
      await initializeMetadata(client, definitions);
      const applied = await readApplied(client);
      assertExactHistory(applied, definitions);
      return applied;
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #withLock<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
      return await operation(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
      } finally {
        client.release();
      }
    }
  }
}

function optionValue(arguments_: readonly string[], prefix: string): string | undefined {
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function runCli(): Promise<void> {
  const command = process.argv[2];
  if (!['up', 'down', 'status'].includes(command ?? '')) {
    throw new Error('Usage: migrate.ts <up|down|status> [--directory=<path>]');
  }
  const config = loadMigrationConfig();
  const directory = optionValue(process.argv.slice(3), '--directory=');
  const migrator = new SqlMigrator(config.databaseUrl, directory, config.databaseTls);
  try {
    const result =
      command === 'up'
        ? await migrator.up()
        : command === 'down'
          ? await migrator.down()
          : await migrator.status();
    process.stdout.write(`${JSON.stringify({ event: `migration.${command}`, result })}\n`);
  } finally {
    await migrator.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.endsWith(resolve('scripts/db/migrate.ts'))) {
  void runCli().catch((error: unknown) => {
    const message =
      error instanceof ConfigValidationError || error instanceof MigrationExecutionError
        ? error.message
        : 'Migration command failed.';
    process.stderr.write(`${JSON.stringify({ event: 'migration.failed', message })}\n`);
    process.exitCode = 1;
  });
}
