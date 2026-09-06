import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { loadMigrationConfig } from '../../packages/config/src/index.js';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from '../../packages/test-support/src/index.js';
import { SqlMigrator } from './migrate.js';

interface Pair {
  readonly version: string;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writePair(directory: string, pair: Pair): Promise<void> {
  await Promise.all([
    writeFile(join(directory, `${pair.version}_${pair.name}.up.sql`), pair.up, 'utf8'),
    writeFile(join(directory, `${pair.version}_${pair.name}.down.sql`), pair.down, 'utf8'),
  ]);
}

async function removePair(directory: string, pair: Pair): Promise<void> {
  await Promise.all([
    unlink(join(directory, `${pair.version}_${pair.name}.up.sql`)),
    unlink(join(directory, `${pair.version}_${pair.name}.down.sql`)),
  ]);
}

async function withScenario(
  name: string,
  pairs: readonly Pair[],
  test: (context: {
    readonly databaseUrl: string;
    readonly directory: string;
    readonly migrator: SqlMigrator;
  }) => Promise<void>,
): Promise<void> {
  const adminUrl = loadMigrationConfig().databaseUrl;
  const database = await createDisposableDatabase(adminUrl, `trayvi_integrity_${name}`);
  const directory = await mkdtemp(join(tmpdir(), 'trayvi-migrations-'));
  await Promise.all(pairs.map((pair) => writePair(directory, pair)));
  const migrator = new SqlMigrator(database.url, directory);
  try {
    await test({ databaseUrl: database.url, directory, migrator });
  } finally {
    await migrator.close();
    await dropDisposableDatabase(adminUrl, database.name);
    await rm(directory, { recursive: true, force: true });
  }
}

const first: Pair = {
  version: '0001',
  name: 'first',
  up: 'CREATE TABLE public.first_migration (id integer PRIMARY KEY);',
  down: 'DROP TABLE public.first_migration;',
};
const second: Pair = {
  version: '0002',
  name: 'second',
  up: 'CREATE TABLE public.second_migration (id integer PRIMARY KEY);',
  down: 'DROP TABLE public.second_migration;',
};

describe('migration history integrity', () => {
  it('rejects an applied version unknown to the repository', async () => {
    await withScenario('unknown', [first], async ({ databaseUrl, migrator }) => {
      await migrator.up();
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO public.trayvi_schema_migrations
             (version, name, up_checksum, down_checksum, pair_checksum)
           VALUES ('9999', 'unknown', $1, $1, $1)`,
          ['0'.repeat(64)],
        );
      } finally {
        await client.end();
      }

      await expect(migrator.up()).rejects.toThrow('not a valid repository prefix');
    });
  });

  it('rejects missing local migrations and gaps', async () => {
    await withScenario(
      'corruption',
      [first, second],
      async ({ databaseUrl, directory, migrator }) => {
        await migrator.up();
        await removePair(directory, second);
        await expect(migrator.up()).rejects.toThrow('not a valid repository prefix');
        await writePair(directory, second);

        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try {
          await client.query("DELETE FROM public.trayvi_schema_migrations WHERE version = '0001'");
        } finally {
          await client.end();
        }
        await expect(migrator.up()).rejects.toThrow('not a valid repository prefix');
      },
    );
  });

  it('rejects incomplete migration metadata', async () => {
    await withScenario('incomplete', [first], async ({ databaseUrl, migrator }) => {
      await migrator.up();
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('ALTER TABLE public.trayvi_schema_migrations DROP COLUMN pair_checksum');
      } finally {
        await client.end();
      }
      await expect(migrator.status()).rejects.toThrow('incomplete or unsupported');
    });
  });

  it('detects changes to either member of an applied migration pair', async () => {
    await withScenario('pair_drift', [first], async ({ directory, migrator }) => {
      await migrator.up();
      await writeFile(join(directory, '0001_first.up.sql'), `${first.up}\nSELECT 1;`, 'utf8');
      await expect(migrator.up()).rejects.toThrow('not a valid repository prefix');

      await writeFile(join(directory, '0001_first.up.sql'), first.up, 'utf8');
      await writeFile(
        join(directory, '0001_first.down.sql'),
        `${first.down}\nCREATE TABLE public.down_drift_marker (id integer);`,
        'utf8',
      );
      await expect(migrator.down()).rejects.toThrow('not a valid repository prefix');
    });
  });

  it('accepts an exact valid prefix, repeat no-op, rollback, and roll-forward', async () => {
    await withScenario('valid_prefix', [first], async ({ directory, migrator }) => {
      expect(await migrator.up()).toEqual({ applied: ['0001'], skipped: [] });
      await writePair(directory, second);
      expect(await migrator.up()).toEqual({ applied: ['0002'], skipped: ['0001'] });
      expect(await migrator.up()).toEqual({ applied: [], skipped: ['0001', '0002'] });
      expect(await migrator.down()).toEqual(['0002']);
      expect(await migrator.up()).toEqual({ applied: ['0002'], skipped: ['0001'] });
    });
  });

  it('upgrades only an exact legacy history and authenticates the down SQL', async () => {
    await withScenario('legacy', [first], async ({ databaseUrl, migrator }) => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query(first.up);
        await client.query(`
          CREATE TABLE public.trayvi_schema_migrations (
            version varchar(32) PRIMARY KEY,
            name varchar(160) NOT NULL,
            checksum char(64) NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
          )
        `);
        await client.query(
          `INSERT INTO public.trayvi_schema_migrations (version, name, checksum)
           VALUES ('0001', 'first', $1)`,
          [digest(first.up)],
        );
      } finally {
        await client.end();
      }

      expect(await migrator.up()).toEqual({ applied: [], skipped: ['0001'] });
      const status = await migrator.status();
      expect(status[0]).toMatchObject({
        version: '0001',
        upChecksum: digest(first.up),
        downChecksum: digest(first.down),
        pairChecksum: digest(`${digest(first.up)}:${digest(first.down)}`),
      });
    });
  });
});
