import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';

const DATABASE_BOOTSTRAP_LOCK_ID = '84932675001376';

interface EndableDatabaseClient {
  end(): Promise<void>;
}

interface CloseableDatabaseClient {
  close(): Promise<void>;
}

function safeDatabaseName(prefix: string): string {
  const normalized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, '_')
    .slice(0, 24);
  return `${normalized}_${randomUUID().replaceAll('-', '')}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) throw new Error('Unsafe database identifier.');
  return `"${identifier}"`;
}

export function databaseUrlForName(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createDisposableDatabase(
  adminUrl: string,
  prefix = 'trayvi_test',
): Promise<{ readonly name: string; readonly url: string }> {
  const name = safeDatabaseName(prefix);
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`);
  } finally {
    await client.end();
  }
  return { name, url: databaseUrlForName(adminUrl, name) };
}

export async function createNamedDisposableDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`);
  } finally {
    await client.end();
  }
}

export async function dropDisposableDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

export async function executeSqlFile(databaseUrl: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function ensureDatabaseBootstrap(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  let connected = false;
  let locked = false;
  let primaryError: unknown;

  try {
    await client.connect();
    connected = true;
    await client.query('SELECT pg_advisory_lock($1::bigint)', [DATABASE_BOOTSTRAP_LOCK_ID]);
    locked = true;
    const bootstrap = await readFile(resolve('infra/database/bootstrap/0001_roles.sql'), 'utf8');
    await client.query(bootstrap);
  } catch (error: unknown) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (locked) {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [DATABASE_BOOTSTRAP_LOCK_ID]);
    } catch (error: unknown) {
      cleanupError = error;
    }
  }
  if (connected) {
    try {
      await client.end();
    } catch (error: unknown) {
      cleanupError ??= error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

export async function closeInitializedDatabaseClients(resources: {
  readonly pool?: EndableDatabaseClient;
  readonly migrator?: CloseableDatabaseClient;
}): Promise<void> {
  const errors: unknown[] = [];
  if (resources.pool) {
    try {
      await resources.pool.end();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (resources.migrator) {
    try {
      await resources.migrator.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Database client cleanup failed.');
}

export type RestrictedWorkloadRole = 'trayvi_runtime' | 'trayvi_verification';

export async function createRestrictedRuntimeLogin(
  adminUrl: string,
  targetDatabaseUrl = adminUrl,
  role: RestrictedWorkloadRole = 'trayvi_runtime',
): Promise<{ readonly name: string; readonly url: string }> {
  const name = safeDatabaseName(`${role}_test`);
  const password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const createRole = await client.query<{ sql: string }>(
      `SELECT format(
         'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
         $1::text,
         $2::text
       ) AS sql`,
      [name, password],
    );
    const createRoleSql = createRole.rows[0]?.sql;
    if (!createRoleSql) throw new Error('Could not construct restricted runtime role SQL.');
    await client.query(createRoleSql);
    await client.query(`GRANT ${quoteIdentifier(role)} TO ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
  const url = new URL(targetDatabaseUrl);
  url.username = name;
  url.password = password;
  return { name, url: url.toString() };
}

export async function dropRestrictedRuntimeLogin(
  adminUrl: string,
  name: string,
  role: RestrictedWorkloadRole = 'trayvi_runtime',
): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`REVOKE ${quoteIdentifier(role)} FROM ${quoteIdentifier(name)}`);
    await client.query(`DROP ROLE ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}
