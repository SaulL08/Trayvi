import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMigrationConfig, parseAuthConfig } from '../../../../packages/config/src/index';
import {
  closeInitializedDatabaseClients,
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '../../../../packages/test-support/src/index';
import { SqlMigrator } from '../../../../scripts/db/migrate';
import type { RateLimitDimension, RateLimitRule } from '../../src/contracts/rate-limit';
import type { SqlExecutor } from '../../src/contracts/runtime';
import { RateLimitPolicy } from '../../src/domain/rate-limit/rate-limit-policy';
import { PostgresRateLimiter } from '../../src/infrastructure/rate-limit/postgres-rate-limiter';

const defaults = parseAuthConfig({}, 'test').rateLimits as readonly RateLimitRule[];

function policyWith(overrides: Partial<Record<RateLimitDimension, number>> = {}): RateLimitPolicy {
  return new RateLimitPolicy(
    defaults.map((rule) => ({ ...rule, limit: overrides[rule.dimension] ?? rule.limit })),
  );
}

function executorOver(pool: Pool): SqlExecutor {
  return {
    query: async <Row extends object>(text: string, values: readonly unknown[]) => {
      const result = await pool.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

const subject = (): Buffer => randomBytes(32);
const at = (iso: string): Date => new Date(iso);

describe('auth rate limiting on real PostgreSQL', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  let admin: Pool;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtimePool: Pool | undefined;

  const limiter = (policy = policyWith()): PostgresRateLimiter => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    return new PostgresRateLimiter(executorOver(runtimePool), policy);
  };

  const storedCount = async (dimension: RateLimitDimension, key: Buffer, windowStart: Date) =>
    Number(
      (
        await admin.query<{ count: number }>(
          'SELECT count FROM auth.rate_limit_buckets WHERE dimension = $1 AND subject = $2 AND window_start = $3',
          [dimension, key, windowStart],
        )
      ).rows[0]?.count ?? 0,
    );

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_rate_limit');
    migrator = new SqlMigrator(database.url);
    await migrator.up();
    admin = new Pool({ connectionString: database.url, max: 4 });
    runtimeLogin = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    runtimePool = new Pool({
      connectionString: runtimeLogin.url,
      max: 20,
      statement_timeout: 30_000,
    });
  });

  afterAll(async () => {
    await runtimePool?.end();
    if (runtimeLogin) await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, runtimeLogin.name);
    await closeInitializedDatabaseClients({ pool: admin, migrator });
    if (database) {
      await delay(50);
      await dropDisposableDatabase(adminConfig.databaseUrl, database.name);
    }
  });

  it('admits exactly the limit when 200 connections consume one bucket concurrently', async () => {
    const rateLimiter = limiter(policyWith({ CHALLENGE_START_NETWORK_HOUR: 50 }));
    const key = subject();
    const now = at('2026-11-03T12:10:00.000Z');
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () =>
        rateLimiter.consume('CHALLENGE_START_NETWORK_HOUR', key, now),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(50);
    const remaining = decisions
      .flatMap((decision) => (decision.allowed ? [decision.remaining] : []))
      .sort((left, right) => left - right);
    expect(remaining).toEqual(Array.from({ length: 50 }, (_, index) => index));
    // Denied attempts are not counted, so the stored count is exactly the limit.
    expect(
      await storedCount('CHALLENGE_START_NETWORK_HOUR', key, at('2026-11-03T12:00:00.000Z')),
    ).toBe(50);
  });

  it('counts the previous window so no interval of one window admits more than the limit', async () => {
    const rateLimiter = limiter();
    const key = subject();
    // 5 per hour: spend all 5 just before the boundary, then nothing until the next window ends.
    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await rateLimiter.consume(
            'CHALLENGE_START_CONTACT_HOUR',
            key,
            at('2026-11-03T12:59:00.000Z'),
          )
        ).allowed,
      ).toBe(true);
    }
    expect(
      await rateLimiter.consume(
        'CHALLENGE_START_CONTACT_HOUR',
        key,
        at('2026-11-03T13:00:30.000Z'),
      ),
    ).toEqual({
      allowed: false,
      retryAfterSeconds: 3_570,
    });
    expect(
      await rateLimiter.peek('CHALLENGE_START_CONTACT_HOUR', key, at('2026-11-03T13:59:59.000Z')),
    ).toMatchObject({ allowed: false });
    expect(
      await rateLimiter.consume(
        'CHALLENGE_START_CONTACT_HOUR',
        key,
        at('2026-11-03T14:00:00.000Z'),
      ),
    ).toEqual({
      allowed: true,
      remaining: 4,
    });
  });

  it('peeks without consuming and keys buckets by dimension and subject', async () => {
    const rateLimiter = limiter(policyWith({ CHALLENGE_VERIFY_FAILURE_CONTACT_DAY: 2 }));
    const key = subject();
    const now = at('2026-11-03T08:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      expect(await rateLimiter.peek('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', key, now)).toEqual({
        allowed: true,
        remaining: 2,
      });
    }
    await rateLimiter.consume('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', key, now);
    await rateLimiter.consume('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', key, now);
    expect((await rateLimiter.peek('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', key, now)).allowed).toBe(
      false,
    );
    expect(
      (await rateLimiter.peek('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', subject(), now)).allowed,
    ).toBe(true);
    expect((await rateLimiter.peek('CHALLENGE_START_CONTACT_DAY', key, now)).allowed).toBe(true);
  });

  it('bounds a one-day brute force on one number to 10 guesses (probability <= 10 / 10^6)', async () => {
    // The attacker restarts challenges and submits wrong codes as fast as every limit allows, for
    // a full day that straddles a daily window boundary.
    const rateLimiter = limiter();
    const contact = subject();
    const policy = { maxFailedAttempts: 5 };
    const start = at('2026-11-03T12:00:00.000Z').getTime();
    let guesses = 0;
    let challengesStarted = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const now = new Date(start + minute * 60_000);
      const startHour = await rateLimiter.consume('CHALLENGE_START_CONTACT_HOUR', contact, now);
      const startDay = startHour.allowed
        ? await rateLimiter.consume('CHALLENGE_START_CONTACT_DAY', contact, now)
        : startHour;
      if (!startDay.allowed) continue;
      challengesStarted += 1;
      for (let attempt = 0; attempt < policy.maxFailedAttempts; attempt += 1) {
        if (!(await rateLimiter.peek('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', contact, now)).allowed)
          break;
        guesses += 1;
        await rateLimiter.consume('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', contact, now);
      }
    }
    expect(challengesStarted).toBeLessThanOrEqual(10);
    expect(guesses).toBeLessThanOrEqual(10);
    expect(guesses / 1_000_000).toBeLessThanOrEqual(10 / 1_000_000);
  }, 120_000);

  it('prunes only buckets that no longer count toward a decision', async () => {
    const rateLimiter = limiter();
    const key = subject();
    await rateLimiter.consume('DELIVERY_GLOBAL_MINUTE', key, at('2026-11-03T10:00:10.000Z'));
    await rateLimiter.consume('DELIVERY_GLOBAL_MINUTE', key, at('2026-11-03T10:01:10.000Z'));
    await rateLimiter.consume('CHALLENGE_START_CONTACT_DAY', key, at('2026-11-03T10:00:10.000Z'));
    await expect(rateLimiter.prune(at('2026-11-03T10:02:30.000Z'))).resolves.toBe(1);
    expect(await storedCount('DELIVERY_GLOBAL_MINUTE', key, at('2026-11-03T10:00:00.000Z'))).toBe(
      0,
    );
    expect(await storedCount('DELIVERY_GLOBAL_MINUTE', key, at('2026-11-03T10:01:00.000Z'))).toBe(
      1,
    );
    expect(
      await storedCount('CHALLENGE_START_CONTACT_DAY', key, at('2026-11-03T00:00:00.000Z')),
    ).toBe(1);
  });

  it('stores only 32-byte commitments and limits runtime writes to the count', async () => {
    const rateLimiter = limiter();
    await expect(
      rateLimiter.consume('CHALLENGE_START_CONTACT_HOUR', Buffer.from('+18095550100'), new Date()),
    ).rejects.toThrow('RATE_LIMIT_SUBJECT_INVALID');
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    const failure = async (statement: string, values: readonly unknown[]) => {
      try {
        await runtimePool?.query(statement, [...values]);
        return undefined;
      } catch (error: unknown) {
        const detail = error as { code?: string; constraint?: string };
        return detail.constraint ?? detail.code;
      }
    };
    expect(
      await failure(
        `INSERT INTO auth.rate_limit_buckets (dimension, subject, window_start, count) VALUES ('CHALLENGE_START_CONTACT_HOUR', $1, clock_timestamp(), 1)`,
        [Buffer.from('+18095550100')],
      ),
    ).toBe('rate_limit_subject_commitment');
    expect(await failure(`UPDATE auth.rate_limit_buckets SET subject = $1`, [subject()])).toBe(
      '42501',
    );
    expect(
      await failure(`UPDATE auth.rate_limit_buckets SET window_start = clock_timestamp()`, []),
    ).toBe('42501');
    expect(await failure(`UPDATE auth.rate_limit_buckets SET count = -1`, [])).toBe(
      'rate_limit_count_nonnegative',
    );
    expect(await failure(`DROP TABLE auth.rate_limit_buckets`, [])).toBe('42501');
  });

  it('refuses to roll back migration 0015 while buckets exist', async () => {
    const versions = (await migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0015').reverse()) {
      expect(await migrator.down()).toEqual([version]);
    }
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0015');
    await migrator.up();
  });
});
