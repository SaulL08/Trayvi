import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { ConfigValidationError, loadMigrationConfig } from '../../packages/config/src/index.js';

const MIGRATION_LOCK_ID = '84932675001377';
const DEFAULT_MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'infra/database/migrations');

interface MigrationDefinition {
  readonly version: string;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
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

async function loadMigrations(directory: string): Promise<readonly MigrationDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const upFiles = entries
    .filter((entry) => entry.isFile() && /^\d{4,}_[a-z0-9_]+\.up\.sql$/u.test(entry.name))
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
    definitions.push({
      version: match[1],
      name: match[2],
      upSql,
      downSql,
      checksum: checksum(upSql),
    });
  }

  const versions = definitions.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length)
    throw new Error('Migration versions must be unique.');
  return definitions;
}

async function initializeMetadata(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.trayvi_schema_migrations (
      version varchar(32) PRIMARY KEY,
      name varchar(160) NOT NULL,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    REVOKE ALL ON TABLE public.trayvi_schema_migrations FROM PUBLIC;
  `);
}

async function readApplied(client: PoolClient): Promise<readonly AppliedMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(
    'SELECT version, name, checksum, applied_at FROM public.trayvi_schema_migrations ORDER BY version',
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export class SqlMigrator {
  readonly #pool: Pool;
  readonly #directory: string;

  constructor(databaseUrl: string, migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY) {
    this.#directory = migrationsDirectory;
    this.#pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      max: 2,
      statement_timeout: 30_000,
    });
  }

  async up(): Promise<MigrationRunResult> {
    const definitions = await loadMigrations(this.#directory);
    return this.#withLock(async (client) => {
      await initializeMetadata(client);
      const applied = await readApplied(client);
      const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
      const result: { applied: string[]; skipped: string[] } = { applied: [], skipped: [] };

      for (const migration of definitions) {
        const existing = appliedByVersion.get(migration.version);
        if (existing) {
          if (existing.checksum !== migration.checksum || existing.name !== migration.name) {
            throw new Error(
              `Applied migration ${migration.version} no longer matches repository SQL.`,
            );
          }
          result.skipped.push(migration.version);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(migration.upSql);
          await client.query(
            `INSERT INTO public.trayvi_schema_migrations (version, name, checksum)
             VALUES ($1, $2, $3)`,
            [migration.version, migration.name, migration.checksum],
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
      await initializeMetadata(client);
      const applied = await readApplied(client);
      const latest = applied.at(-1);
      if (!latest) return [];
      const migration = definitions.find((candidate) => candidate.version === latest.version);
      if (!migration || migration.checksum !== latest.checksum) {
        throw new Error(
          `Cannot safely roll back migration ${latest.version}; repository SQL differs.`,
        );
      }
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
      await initializeMetadata(client);
      return readApplied(client);
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
  const migrator = new SqlMigrator(config.databaseUrl, directory);
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
