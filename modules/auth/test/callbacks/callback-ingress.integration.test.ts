import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMigrationConfig } from '../../../../packages/config/src/index';
import {
  closeInitializedDatabaseClients,
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '../../../../packages/test-support/src/index';
import { SqlMigrator } from '../../../../scripts/db/migrate';
import { SignedCallbackIngress } from '../../src/application/callbacks/signed-callback-ingress';
import type { CallbackHandler, VerifiedCallback } from '../../src/contracts/callbacks';
import type { IdGenerator, SqlExecutor, TransactionRunner } from '../../src/contracts/runtime';
import { DeliveryStatusCallbackHandler } from '../../src/infrastructure/callbacks/delivery-status-handler';
import { PostgresCallbackReceiptStore } from '../../src/infrastructure/callbacks/postgres-callback-receipts';

const uuidV7: IdGenerator = {
  uuidV7: () => {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(Date.now(), 0, 6);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const value = bytes.toString('hex');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  },
};

const syntheticSecret = Buffer.alloc(32, 0x51);
const otherSecret = Buffer.alloc(32, 0x52);
const now = new Date('2026-11-03T12:00:00.000Z');
const nowSeconds = String(Math.floor(now.getTime() / 1_000));

function sign(secret: Buffer, timestamp: string, body: Buffer): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

/** Stand-in for SPEC-003's re-verification handler: records what it was given. */
class RecordingHandler implements CallbackHandler {
  readonly kind = 'reverification' as const;
  readonly allowedFields = {
    caseReference: 'string',
    matched: 'boolean',
    score: 'number',
  } as const;
  readonly seen: VerifiedCallback[] = [];
  fail: 'THROW' | 'BAD_OUTCOME' | undefined;

  async handle(
    sql: SqlExecutor,
    callback: VerifiedCallback,
  ): Promise<{ readonly outcomeCode: string }> {
    // A real effect in the same transaction, so rollback behaviour is observable.
    await sql.query('SELECT 1', []);
    if (this.fail === 'THROW') throw new Error('handler failure');
    this.seen.push(callback);
    return { outcomeCode: this.fail === 'BAD_OUTCOME' ? 'not a code' : 'MATCH_RECORDED' };
  }
}

function transactionsOver(pool: Pool): TransactionRunner {
  return {
    inTransaction: async <T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await work({
          query: async <Row extends object>(text: string, values: readonly unknown[]) => {
            const result = await client.query<Row>(text, [...values]);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
        });
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

describe('signed provider callbacks on real PostgreSQL', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  let admin: Pool;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtimePool: Pool | undefined;

  const harness = () => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    const handler = new RecordingHandler();
    const ingress = new SignedCallbackIngress({
      transactions: transactionsOver(runtimePool),
      providers: [
        { alias: 'synthetic', secret: syntheticSecret },
        { alias: 'other-provider', secret: otherSecret },
      ],
      handlers: [handler],
      receipts: new PostgresCallbackReceiptStore(),
      ids: uuidV7,
      maxBodyBytes: 16_384,
      timestampToleranceSeconds: 300,
    });
    return { handler, ingress };
  };

  const body = (eventId: string, extra: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        providerEventId: eventId,
        caseReference: 'case-1',
        matched: true,
        ...extra,
      }),
    );

  const receive = (
    ingress: SignedCallbackIngress,
    rawBody: Buffer,
    overrides: {
      alias?: string;
      kind?: string;
      timestamp?: string | undefined;
      signature?: string | undefined;
    } = {},
  ) => {
    const timestamp = 'timestamp' in overrides ? overrides.timestamp : nowSeconds;
    return ingress.receive({
      providerAlias: overrides.alias ?? 'synthetic',
      kind: overrides.kind ?? 'reverification',
      timestampHeader: timestamp,
      signatureHeader:
        'signature' in overrides
          ? overrides.signature
          : sign(syntheticSecret, timestamp ?? '', rawBody),
      rawBody,
      receivedAt: now,
    });
  };

  const receiptCount = async (): Promise<number> =>
    Number(
      (await admin.query<{ count: string }>('SELECT count(*) FROM auth.provider_callback_receipts'))
        .rows[0]?.count,
    );

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_callbacks');
    migrator = new SqlMigrator(database.url);
    await migrator.up();
    admin = new Pool({ connectionString: database.url, max: 4 });
    runtimeLogin = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    runtimePool = new Pool({
      connectionString: runtimeLogin.url,
      max: 25,
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

  it('accepts a signed, fresh callback and passes only allowlisted, well-typed fields', async () => {
    const { handler, ingress } = harness();
    const raw = body('evt-accepted-1', {
      score: 'high',
      phoneNumber: '+18095550199',
      nested: { a: 1 },
    });
    await expect(receive(ingress, raw)).resolves.toEqual({ kind: 'ACCEPTED' });
    expect(handler.seen).toHaveLength(1);
    expect(handler.seen[0]).toMatchObject({
      providerAlias: 'synthetic',
      kind: 'reverification',
      providerEventId: 'evt-accepted-1',
      fields: { caseReference: 'case-1', matched: true },
    });
    expect(Object.keys(handler.seen[0]?.fields ?? {}).sort()).toEqual(['caseReference', 'matched']);

    const receipt = await admin.query<Record<string, unknown>>(
      `SELECT * FROM auth.provider_callback_receipts WHERE provider_event_id = 'evt-accepted-1'`,
    );
    expect(receipt.rows[0]).toMatchObject({
      provider_alias: 'synthetic',
      kind: 'reverification',
      outcome_code: 'MATCH_RECORDED',
    });
    // R-28: the raw body is not retained anywhere in the receipt.
    expect(JSON.stringify(receipt.rows[0])).not.toContain('8095550199');
    expect(Object.keys(receipt.rows[0] ?? {}).sort()).toEqual([
      'id',
      'kind',
      'outcome_code',
      'provider_alias',
      'provider_event_id',
      'received_at',
    ]);
  });

  it('answers a replay with DUPLICATE and no second effect, even when 20 arrive at once', async () => {
    const { handler, ingress } = harness();
    const raw = body('evt-replayed');
    await expect(receive(ingress, raw)).resolves.toEqual({ kind: 'ACCEPTED' });
    await expect(receive(ingress, raw)).resolves.toEqual({ kind: 'DUPLICATE' });
    expect(handler.seen).toHaveLength(1);

    const concurrent = body('evt-concurrent');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => receive(ingress, concurrent)),
    );
    expect(results.filter((result) => result.kind === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'DUPLICATE')).toHaveLength(19);
    expect(
      handler.seen.filter((callback) => callback.providerEventId === 'evt-concurrent'),
    ).toHaveLength(1);
  });

  it('rejects every authentication failure with one identical result and stores nothing', async () => {
    const { handler, ingress } = harness();
    const before = await receiptCount();
    const raw = body('evt-rejected');
    const stale = String(Number(nowSeconds) - 301);
    const future = String(Number(nowSeconds) + 301);
    const oversized = Buffer.concat([raw, Buffer.alloc(16_384)]);
    const attempts = [
      receive(ingress, raw, { alias: 'unknown-provider' }),
      receive(ingress, raw, { signature: sign(otherSecret, nowSeconds, raw) }),
      receive(ingress, raw, { alias: 'other-provider' }),
      receive(ingress, raw, { signature: undefined }),
      receive(ingress, raw, { signature: `v1=${'0'.repeat(64)}` }),
      receive(ingress, raw, {
        signature: sign(syntheticSecret, nowSeconds, raw).replace('v1=', 'v2='),
      }),
      receive(ingress, raw, { signature: sign(syntheticSecret, nowSeconds, raw).toUpperCase() }),
      receive(ingress, raw, { timestamp: stale, signature: sign(syntheticSecret, stale, raw) }),
      receive(ingress, raw, { timestamp: future, signature: sign(syntheticSecret, future, raw) }),
      receive(ingress, raw, { timestamp: undefined, signature: sign(syntheticSecret, '', raw) }),
      receive(ingress, raw, {
        timestamp: `${nowSeconds}.5`,
        signature: sign(syntheticSecret, `${nowSeconds}.5`, raw),
      }),
      // The signature covers the timestamp: replaying it with a fresh timestamp fails.
      receive(ingress, raw, {
        timestamp: String(Number(nowSeconds) + 1),
        signature: sign(syntheticSecret, nowSeconds, raw),
      }),
      receive(ingress, Buffer.concat([raw, Buffer.from(' ')]), {
        signature: sign(syntheticSecret, nowSeconds, raw),
      }),
      receive(ingress, oversized),
      receive(ingress, raw, { kind: 'delivery-status' }),
      receive(ingress, raw, { kind: 'unknown-kind' }),
    ];
    const results = await Promise.all(attempts);
    expect(results).toEqual(attempts.map(() => ({ kind: 'REJECTED' })));
    expect(handler.seen).toHaveLength(0);
    expect(await receiptCount()).toBe(before);
    // Within the 300-second window either side is accepted.
    const edge = String(Number(nowSeconds) - 300);
    await expect(
      receive(ingress, body('evt-edge'), {
        timestamp: edge,
        signature: sign(syntheticSecret, edge, body('evt-edge')),
      }),
    ).resolves.toEqual({
      kind: 'ACCEPTED',
    });
  });

  it('rejects an authenticated body that is not an object with a valid event ID', async () => {
    const { handler, ingress } = harness();
    for (const raw of [
      Buffer.from('not json'),
      Buffer.from('[]'),
      Buffer.from('{"caseReference":"case-1"}'),
      Buffer.from('{"providerEventId":"bad id with spaces"}'),
      Buffer.from(`{"providerEventId":"${'x'.repeat(129)}"}`),
    ]) {
      await expect(receive(ingress, raw)).resolves.toEqual({ kind: 'REJECTED' });
    }
    expect(handler.seen).toHaveLength(0);
  });

  it('rolls the receipt back with a failed handler so the provider retry is processed', async () => {
    const { handler, ingress } = harness();
    const raw = body('evt-retried');
    handler.fail = 'THROW';
    await expect(receive(ingress, raw)).rejects.toThrow('handler failure');
    handler.fail = 'BAD_OUTCOME';
    await expect(receive(ingress, raw)).rejects.toThrow('CALLBACK_OUTCOME_INVALID');
    expect(
      (
        await admin.query(
          `SELECT 1 FROM auth.provider_callback_receipts WHERE provider_event_id = 'evt-retried'`,
        )
      ).rows,
    ).toHaveLength(0);
    handler.fail = undefined;
    await expect(receive(ingress, raw)).resolves.toEqual({ kind: 'ACCEPTED' });
  });

  it('limits the runtime to inserting receipts and recording an outcome once', async () => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    const failure = async (statement: string) => {
      try {
        await runtimePool?.query(statement);
        return undefined;
      } catch (error: unknown) {
        const detail = error as { code?: string; constraint?: string };
        return detail.constraint ?? detail.code;
      }
    };
    expect(await failure('DELETE FROM auth.provider_callback_receipts')).toBe('42501');
    expect(
      await failure(`UPDATE auth.provider_callback_receipts SET provider_event_id = 'forged'`),
    ).toBe('42501');
    expect(
      await failure(`UPDATE auth.provider_callback_receipts SET outcome_code = 'OVERWRITTEN'`),
    ).toBe('provider_callback_receipt_immutable');
  });

  it('records provider delivery status on the referenced challenge only through the narrow command', async () => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    const ingress = new SignedCallbackIngress({
      transactions: transactionsOver(runtimePool),
      providers: [{ alias: 'synthetic', secret: syntheticSecret }],
      handlers: [new DeliveryStatusCallbackHandler()],
      receipts: new PostgresCallbackReceiptStore(),
      ids: uuidV7,
      maxBodyBytes: 16_384,
      timestampToleranceSeconds: 300,
    });
    const challenge = async (deliveryOutcome: string): Promise<string> => {
      const id = uuidV7.uuidV7();
      await admin.query(
        `INSERT INTO auth.verification_challenges (
           id, purpose, destination_key_version, destination_fingerprint, otp_commitment,
           otp_key_version, installation_commitment, failed_attempts, max_failed_attempts,
           resend_count, max_resends, last_sent_at, expires_at, delivery_outcome_code, state,
           created_at, updated_at
         ) VALUES ($1, 'CONTACT_PROOF', 'contact-v1', $2, $3, 'otp-v1', $4, 0, 5, 0, 3,
           $5, $5::timestamptz + interval '5 minutes', $6, 'PENDING', $5, $5)`,
        [id, randomBytes(32), randomBytes(32), randomBytes(32), now, deliveryOutcome],
      );
      return id;
    };
    const status = async (id: string) =>
      (
        await admin.query<{ code: string }>(
          'SELECT delivery_outcome_code AS code FROM auth.verification_challenges WHERE id = $1',
          [id],
        )
      ).rows[0]?.code;
    const outcome = async (eventId: string) =>
      (
        await admin.query<{ code: string }>(
          `SELECT outcome_code AS code FROM auth.provider_callback_receipts WHERE provider_event_id = $1`,
          [eventId],
        )
      ).rows[0]?.code;
    const deliver = (eventId: string, fields: Record<string, unknown>) => {
      const raw = Buffer.from(JSON.stringify({ providerEventId: eventId, ...fields }));
      return receive(ingress, raw, {
        kind: 'delivery-status',
        signature: sign(syntheticSecret, nowSeconds, raw),
      });
    };

    const sent = await challenge('SENT');
    await expect(
      deliver('dlr-1', { reference: sent, status: 'DELIVERED', phoneNumber: '+18095550177' }),
    ).resolves.toEqual({
      kind: 'ACCEPTED',
    });
    expect(await status(sent)).toBe('DELIVERED');
    expect(await outcome('dlr-1')).toBe('RECORDED_DELIVERED');
    // A later report for the same message cannot rewrite a recorded status.
    await expect(deliver('dlr-2', { reference: sent, status: 'UNDELIVERED' })).resolves.toEqual({
      kind: 'ACCEPTED',
    });
    expect(await status(sent)).toBe('DELIVERED');
    expect(await outcome('dlr-2')).toBe('IGNORED_NOT_SENT');
    await expect(deliver('dlr-1', { reference: sent, status: 'UNDELIVERED' })).resolves.toEqual({
      kind: 'DUPLICATE',
    });

    const undelivered = await challenge('SENT');
    await deliver('dlr-3', { reference: undelivered, status: 'UNDELIVERED' });
    expect(await status(undelivered)).toBe('UNDELIVERED');

    const budgetExhausted = await challenge('BUDGET_EXHAUSTED');
    await deliver('dlr-4', { reference: budgetExhausted, status: 'DELIVERED' });
    expect(await status(budgetExhausted)).toBe('BUDGET_EXHAUSTED');

    await deliver('dlr-5', { reference: uuidV7.uuidV7(), status: 'DELIVERED' });
    expect(await outcome('dlr-5')).toBe('UNKNOWN_REFERENCE');
    await deliver('dlr-6', { reference: 'not-a-uuid', status: 'DELIVERED' });
    expect(await outcome('dlr-6')).toBe('IGNORED_INVALID_REFERENCE');
    const pending = await challenge('SENT');
    await deliver('dlr-7', { reference: pending, status: 'READ' });
    await deliver('dlr-8', { reference: pending, status: 7 });
    expect(await outcome('dlr-7')).toBe('IGNORED_INVALID_STATUS');
    expect(await outcome('dlr-8')).toBe('IGNORED_INVALID_STATUS');
    expect(await status(pending)).toBe('SENT');
  });

  it('refuses to roll back migration 0016 while receipts exist', async () => {
    const versions = (await migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0016').reverse()) {
      expect(await migrator.down()).toEqual([version]);
    }
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0016');
    await migrator.up();
  });
});
