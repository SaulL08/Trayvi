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

import { loadMigrationConfig } from '../../../../packages/config/src/index';
import { SqlMigrator } from '../../../../scripts/db/migrate';
import { ContactPointAccountLookup } from '../../src/application/contact/contact-account-lookup';
import type { NormalizedPhone } from '../../src/contracts/contact';
import type { IdGenerator, SqlExecutor } from '../../src/contracts/runtime';
import { E164PhoneNormalizer } from '../../src/domain/contact/phone-normalization';
import {
  ContactEnvelopeCipher,
  HmacContactFingerprinter,
} from '../../src/infrastructure/contact/contact-protection';
import { PostgresContactPointCommands } from '../../src/infrastructure/contact/postgres-contact-points';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';

/** RFC 9562 UUIDv7 for test identifiers (production composes the observability generator). */
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

const keyring = new ConfiguredAuthKeyring([
  {
    purpose: 'auth-contact-fingerprint',
    version: 'contact-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x11),
  },
  {
    purpose: 'auth-contact-fingerprint',
    version: 'contact-v0',
    state: 'LOOKUP_ACTIVE',
    material: Buffer.alloc(32, 0x12),
  },
  {
    purpose: 'auth-contact-kek',
    version: 'kek-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x13),
  },
  {
    purpose: 'auth-otp-commitment',
    version: 'otp-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x14),
  },
  {
    purpose: 'auth-subject-commitment',
    version: 'subject-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x15),
  },
]);
const normalizer = new E164PhoneNormalizer({
  defaultCallingCode: '1',
  callingCodes: [{ code: '1', nationalNumberLength: 10, destinationCodes: ['809', '829', '849'] }],
});
const fingerprinter = new HmacContactFingerprinter(keyring);
const contacts = new PostgresContactPointCommands(new ContactEnvelopeCipher(keyring), uuidV7);
const lookup = new ContactPointAccountLookup(contacts);

function phoneFor(index: number): NormalizedPhone {
  const result = normalizer.normalize(`+1809${String(5_550_000 + index).padStart(7, '0')}`);
  if (!result.ok) throw new Error('fixture phone invalid');
  return result.value;
}

async function inTransaction<T>(pool: Pool, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql: SqlExecutor = {
      query: async <Row extends object>(text: string, values: readonly unknown[]) => {
        const result = await client.query<Row>(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    const value = await work(sql);
    await client.query('COMMIT');
    return value;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe('auth contact points on real PostgreSQL', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  // Superuser pool for fixtures and assertions only.
  let admin: Pool;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtimePool: Pool | undefined;

  const runtime = (): Pool => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    return runtimePool;
  };

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
           'auth-contact-test', 'ENROLLMENT_STARTED', $3, clock_timestamp())`,
        [uuidV7.uuidV7(), accountId, uuidV7.uuidV7()],
      );
    });
    return accountId;
  };

  const bind = (accountId: string, phone: NormalizedPhone, pool: Pool = runtime()) =>
    inTransaction(pool, (sql) =>
      contacts.bindPrimary(sql, {
        accountId,
        phone,
        fingerprints: fingerprinter.fingerprint(phone),
        reason: 'REGISTRATION',
        occurredAt: new Date(),
        correlationId: uuidV7.uuidV7(),
      }),
    );

  const counts = async () => {
    const result = await admin.query<{
      contacts: string;
      aliases: string;
      transitions: string;
      events: string;
    }>(
      `SELECT (SELECT count(*) FROM auth.contact_points) AS contacts,
              (SELECT count(*) FROM auth.contact_point_fingerprints) AS aliases,
              (SELECT count(*) FROM auth.contact_point_transitions) AS transitions,
              (SELECT count(*) FROM platform.outbox_events WHERE aggregate_type = 'auth_contact') AS events`,
    );
    const row = result.rows[0];
    return {
      contacts: Number(row?.contacts),
      aliases: Number(row?.aliases),
      transitions: Number(row?.transitions),
      events: Number(row?.events),
    };
  };

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_contact');
    migrator = new SqlMigrator(database.url);
    await migrator.up();
    admin = new Pool({ connectionString: database.url, max: 6 });
    runtimeLogin = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    runtimePool = new Pool({
      connectionString: runtimeLogin.url,
      max: 55,
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

  it('binds a primary contact with its aliases, transition, and allowlisted outbox event', async () => {
    const accountId = await createAccount();
    const phone = phoneFor(1);
    const result = await bind(accountId, phone);
    expect(result.kind).toBe('BOUND');
    const contactId = result.kind === 'BOUND' ? result.contactId : '';

    const aliases = await admin.query<{ key_version: string; active: boolean }>(
      'SELECT key_version, active FROM auth.contact_point_fingerprints WHERE contact_id = $1 ORDER BY key_version',
      [contactId],
    );
    expect(aliases.rows).toEqual([
      { key_version: 'contact-v0', active: true },
      { key_version: 'contact-v1', active: true },
    ]);
    const stored = await admin.query<{ state: string; key_version: string; ciphertext: Buffer }>(
      'SELECT state, key_version, ciphertext FROM auth.contact_points WHERE id = $1',
      [contactId],
    );
    expect(stored.rows[0]?.state).toBe('ACTIVE');
    expect(stored.rows[0]?.key_version).toBe('contact-v1');
    expect(stored.rows[0]?.ciphertext.toString('utf8')).not.toContain('8095550001');

    const events = await admin.query<{
      event_type: string;
      aggregate_id: string;
      payload: Record<string, string>;
    }>(
      `SELECT event_type, aggregate_id, payload FROM platform.outbox_events
       WHERE aggregate_type = 'auth_contact' AND aggregate_id = $1`,
      [contactId],
    );
    expect(events.rows).toEqual([
      {
        event_type: 'auth.contact.bound',
        aggregate_id: contactId,
        payload: { contactId, accountId, reason: 'REGISTRATION' },
      },
    ]);

    await inTransaction(runtime(), async (sql) => {
      await expect(contacts.activePrimary(sql, accountId)).resolves.toEqual({ contactId, phone });
      await expect(
        contacts.findAccountByFingerprints(sql, fingerprinter.fingerprint(phone)),
      ).resolves.toEqual({
        accountId,
        contactId,
      });
      await expect(lookup.exists(sql, fingerprinter.fingerprint(phone))).resolves.toBe(true);
      await expect(lookup.exists(sql, fingerprinter.fingerprint(phoneFor(999)))).resolves.toBe(
        false,
      );
    });
  });

  it('rejects a second binding of the same number or a second primary without orphan rows', async () => {
    const phone = phoneFor(2);
    const owner = await createAccount();
    expect((await bind(owner, phone)).kind).toBe('BOUND');
    const before = await counts();

    expect(await bind(await createAccount(), phone)).toEqual({ kind: 'CONTACT_ALREADY_BOUND' });
    expect(await bind(owner, phoneFor(3))).toEqual({ kind: 'STALE_CONTACT' });
    expect(await counts()).toEqual(before);
  });

  it('matches a number bound under a lookup-active key after primary rotation', async () => {
    const phone = phoneFor(4);
    const accountId = await createAccount();
    const result = await bind(accountId, phone);
    const rotated = new HmacContactFingerprinter(
      new ConfiguredAuthKeyring([
        {
          purpose: 'auth-contact-fingerprint',
          version: 'contact-v2',
          state: 'PRIMARY',
          material: Buffer.alloc(32, 0x16),
        },
        {
          purpose: 'auth-contact-fingerprint',
          version: 'contact-v1',
          state: 'LOOKUP_ACTIVE',
          material: Buffer.alloc(32, 0x11),
        },
        {
          purpose: 'auth-contact-kek',
          version: 'kek-v1',
          state: 'PRIMARY',
          material: Buffer.alloc(32, 0x13),
        },
        {
          purpose: 'auth-otp-commitment',
          version: 'otp-v1',
          state: 'PRIMARY',
          material: Buffer.alloc(32, 0x14),
        },
        {
          purpose: 'auth-subject-commitment',
          version: 'subject-v1',
          state: 'PRIMARY',
          material: Buffer.alloc(32, 0x15),
        },
      ]),
    );
    await inTransaction(runtime(), async (sql) => {
      await expect(
        contacts.findAccountByFingerprints(sql, rotated.fingerprint(phone)),
      ).resolves.toEqual({
        accountId,
        contactId: result.kind === 'BOUND' ? result.contactId : '',
      });
    });
  });

  it('replaces the primary contact atomically and frees the previous number', async () => {
    const accountId = await createAccount();
    const original = phoneFor(5);
    const first = await bind(accountId, original);
    const previousContactId = first.kind === 'BOUND' ? first.contactId : '';
    const replacement = phoneFor(6);
    const caseId = uuidV7.uuidV7();
    const replace = (expectedContactId: string, phone: NormalizedPhone) =>
      inTransaction(runtime(), (sql) =>
        contacts.replacePrimary(sql, {
          accountId,
          expectedContactId,
          phone,
          fingerprints: fingerprinter.fingerprint(phone),
          reason: 'RECOVERY',
          caseId,
          occurredAt: new Date(),
          correlationId: uuidV7.uuidV7(),
        }),
      );

    const result = await replace(previousContactId, replacement);
    expect(result.kind).toBe('BOUND');
    const contactId = result.kind === 'BOUND' ? result.contactId : '';
    const states = await admin.query<{ id: string; state: string }>(
      'SELECT id, state FROM auth.contact_points WHERE account_id = $1 ORDER BY created_at, id',
      [accountId],
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({
      [previousContactId]: 'REPLACED',
      [contactId]: 'ACTIVE',
    });
    const event = await admin.query<{ payload: Record<string, string> }>(
      `SELECT payload FROM platform.outbox_events WHERE event_type = 'auth.contact.replaced' AND aggregate_id = $1`,
      [contactId],
    );
    expect(event.rows[0]?.payload).toEqual({
      contactId,
      previousContactId,
      accountId,
      reason: 'RECOVERY',
      caseId,
    });
    await inTransaction(runtime(), async (sql) => {
      await expect(contacts.activePrimary(sql, accountId)).resolves.toEqual({
        contactId,
        phone: replacement,
      });
    });

    // The replaced contact is stale, and its number may bind elsewhere through a new proof.
    expect(await replace(previousContactId, phoneFor(7))).toEqual({ kind: 'STALE_CONTACT' });
    expect((await bind(await createAccount(), original)).kind).toBe('BOUND');
    // Replacing onto a number another account holds is refused without changing either contact.
    const before = await counts();
    expect(await replace(contactId, original)).toEqual({ kind: 'CONTACT_ALREADY_BOUND' });
    expect(await counts()).toEqual(before);
  });

  it('commits nothing when the caller transaction rolls back after binding', async () => {
    const before = await counts();
    const accountId = await createAccount();
    await expect(
      inTransaction(runtime(), async (sql) => {
        const result = await contacts.bindPrimary(sql, {
          accountId,
          phone: phoneFor(8),
          fingerprints: fingerprinter.fingerprint(phoneFor(8)),
          reason: 'REGISTRATION',
          occurredAt: new Date(),
          correlationId: uuidV7.uuidV7(),
        });
        expect(result.kind).toBe('BOUND');
        throw new Error('caller failure after bind');
      }),
    ).rejects.toThrow('caller failure after bind');
    expect(await counts()).toEqual(before);
  });

  it('denies the runtime every direct write and every envelope read', async () => {
    const client = await runtime().connect();
    const denied = async (
      statement: string,
      values: readonly unknown[] = [],
    ): Promise<string | undefined> => {
      try {
        await client.query(statement, [...values]);
        return undefined;
      } catch (error: unknown) {
        return (error as { code?: string }).code;
      }
    };
    try {
      const contactId = (
        await admin.query<{ id: string }>('SELECT id FROM auth.contact_points LIMIT 1')
      ).rows[0]?.id;
      const statements: readonly (readonly [string, readonly unknown[]])[] = [
        ['SELECT ciphertext FROM auth.contact_points LIMIT 1', []],
        ['SELECT wrapped_dek FROM auth.contact_points LIMIT 1', []],
        [
          `UPDATE auth.contact_points SET state = 'REVOKED', revoked_at = clock_timestamp() WHERE id = $1`,
          [contactId],
        ],
        [
          `UPDATE auth.contact_point_fingerprints SET active = false, deactivated_at = clock_timestamp()`,
          [],
        ],
        ['DELETE FROM auth.contact_points', []],
        ['DELETE FROM auth.contact_point_transitions', []],
        ['SELECT id FROM auth.contact_point_transitions LIMIT 1', []],
        [
          `INSERT INTO auth.contact_point_fingerprints (id, contact_id, channel, normalization_profile, key_version, fingerprint, active, created_at)
           VALUES ($1, $2, 'PHONE', 'e164-v1', 'forged', $3, true, clock_timestamp())`,
          [uuidV7.uuidV7(), contactId, Buffer.alloc(32, 1)],
        ],
        [
          `SELECT auth.insert_active_contact(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
          [],
        ],
        ['CREATE TABLE auth.bypass (id integer)', []],
      ];
      const codes: (string | undefined)[] = [];
      for (const [statement, values] of statements) codes.push(await denied(statement, values));
      expect(codes).toEqual(statements.map(() => '42501'));
    } finally {
      client.release();
    }
  });

  it('enforces the PLAN §5.2 edges and append-only history even for the table owner', async () => {
    const accountId = await createAccount();
    const result = await bind(accountId, phoneFor(9));
    const contactId = result.kind === 'BOUND' ? result.contactId : '';
    const violation = async (statement: string, values: readonly unknown[]) => {
      try {
        await admin.query(statement, [...values]);
        return undefined;
      } catch (error: unknown) {
        return (error as { constraint?: string }).constraint;
      }
    };
    expect(
      await violation(
        `UPDATE auth.contact_points SET ciphertext = decode('00000000000000000000', 'hex') WHERE id = $1`,
        [contactId],
      ),
    ).toBe('contact_point_immutable_fields');
    expect(
      await violation(
        `UPDATE auth.contact_points SET state = 'REVOKED', revoked_at = clock_timestamp() WHERE id = $1`,
        [contactId],
      ),
    ).toBeUndefined();
    expect(
      await violation(
        `UPDATE auth.contact_points SET state = 'ACTIVE', revoked_at = NULL WHERE id = $1`,
        [contactId],
      ),
    ).toBe('contact_point_lifecycle');
    expect(
      await violation(
        `UPDATE auth.contact_point_fingerprints SET active = false, deactivated_at = clock_timestamp() WHERE contact_id = $1`,
        [contactId],
      ),
    ).toBeUndefined();
    // A deactivated alias never becomes active again.
    expect(
      await violation(
        `UPDATE auth.contact_point_fingerprints SET active = true, deactivated_at = NULL WHERE contact_id = $1`,
        [contactId],
      ),
    ).toBe('contact_fingerprint_lifecycle');
    expect(
      await violation(
        `UPDATE auth.contact_point_transitions SET reason = 'RECOVERY' WHERE contact_id = $1`,
        [contactId],
      ),
    ).toBe('contact_transition_immutable');
    expect(
      await violation(
        `INSERT INTO auth.contact_point_transitions (id, contact_id, account_id, from_state, to_state, reason, occurred_at, correlation_id)
         VALUES ($1, $2, $3, 'REPLACED', 'ACTIVE', 'REGISTRATION', clock_timestamp(), $4)`,
        [uuidV7.uuidV7(), contactId, accountId, uuidV7.uuidV7()],
      ),
    ).toBe('contact_transition_edge_valid');
  });

  it('binds exactly one of 50 concurrent claims on one number in each of 10 rounds', async () => {
    const rounds: { round: number; bound: number; alreadyBound: number; activeBindings: number }[] =
      [];
    for (let round = 0; round < 10; round += 1) {
      const phone = phoneFor(1_000 + round);
      const accounts = await Promise.all(Array.from({ length: 50 }, () => createAccount()));
      const results = await Promise.all(accounts.map((accountId) => bind(accountId, phone)));
      const active = await admin.query<{ count: string }>(
        `SELECT count(*) FROM auth.contact_point_fingerprints alias
         WHERE alias.active AND alias.key_version = 'contact-v1' AND alias.fingerprint = $1`,
        [fingerprinter.fingerprint(phone).primary.bytes],
      );
      rounds.push({
        round,
        bound: results.filter((result) => result.kind === 'BOUND').length,
        alreadyBound: results.filter((result) => result.kind === 'CONTACT_ALREADY_BOUND').length,
        activeBindings: Number(active.rows[0]?.count),
      });
    }
    // Machine-readable result for the R-08 evidence (T-A6).
    expect(rounds).toEqual(
      Array.from({ length: 10 }, (_, round) => ({
        round,
        bound: 1,
        alreadyBound: 49,
        activeBindings: 1,
      })),
    );
  }, 120_000);

  it('refuses to roll back migration 0013 while contact points exist', async () => {
    const versions = (await migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0013').reverse()) {
      expect(await migrator.down()).toEqual([version]);
    }
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0013');
    await migrator.up();
  });
});
