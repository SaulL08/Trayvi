import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

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
