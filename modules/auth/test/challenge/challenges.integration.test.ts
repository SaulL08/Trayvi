import { createHmac, randomBytes } from 'node:crypto';
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
import { DefaultContactProofConsumer } from '../../src/application/challenge/contact-proof-consumer';
import { DefaultVerificationChallengeService } from '../../src/application/challenge/verification-challenge-service';
import type {
  ChallengePolicy,
  ChallengePurpose,
  ClientContext,
  ContactAccountLookup,
} from '../../src/contracts/challenge';
import type {
  ContactFingerprinter,
  ContactFingerprintSet,
  NormalizedPhone,
  PhoneNormalizer,
} from '../../src/contracts/contact';
import type {
  DeliveryOutcome,
  DeliveryRequest,
  OtpDeliveryPort,
} from '../../src/contracts/delivery';
import type {
  RateLimitDecision,
  RateLimitDimension,
  RateLimiter,
  SubjectCommitter,
} from '../../src/contracts/rate-limit';
import type { IdGenerator, SqlExecutor, TransactionRunner } from '../../src/contracts/runtime';
import {
  KeyedOtpCommitter,
  RejectionSamplingOtpGenerator,
} from '../../src/infrastructure/challenge/otp';
import { PostgresChallengeStore } from '../../src/infrastructure/challenge/postgres-challenge-store';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';
import { NodeOpaqueTokenCodec } from '../../src/infrastructure/shared/opaque-token-codec';

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

const policy: ChallengePolicy = {
  codeLifetimeSeconds: 300,
  maxFailedAttempts: 5,
  maxResends: 3,
  resendCooldownSeconds: 30,
  proofLifetimeSeconds: 600,
};

const keyring = new ConfiguredAuthKeyring([
  {
    purpose: 'auth-contact-fingerprint',
    version: 'contact-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x21),
  },
  {
    purpose: 'auth-contact-kek',
    version: 'kek-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x22),
  },
  {
    purpose: 'auth-otp-commitment',
    version: 'otp-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x23),
  },
  {
    purpose: 'auth-subject-commitment',
    version: 'subject-v1',
    state: 'PRIMARY',
    material: Buffer.alloc(32, 0x24),
  },
]);

// Stand-ins for the ws-a and ws-c contracts; ws-b consumes only their interfaces.
const normalizer: PhoneNormalizer = {
  normalize: (input) =>
    typeof input === 'string' && /^\+1809[0-9]{7}$/u.test(input)
      ? { ok: true, value: { profile: 'e164-v1', canonical: input } }
      : { ok: false, code: 'INVALID_LENGTH' },
};
const fingerprinter: ContactFingerprinter = {
  fingerprint: (value: NormalizedPhone): ContactFingerprintSet => {
    const primary = {
      channel: 'PHONE' as const,
      profile: 'e164-v1' as const,
      keyVersion: 'contact-v1',
      bytes: createHmac('sha256', Buffer.alloc(32, 0x21)).update(value.canonical).digest(),
    };
    return { primary, lookup: [primary] };
  },
};
const subjects: SubjectCommitter = {
  commit: (label, value) =>
    createHmac('sha256', Buffer.alloc(32, 0x24))
      .update(`${label}\0`)
      .update(typeof value === 'string' ? Buffer.from(value) : value)
      .digest(),
};

class MemoryRateLimiter implements RateLimiter {
  readonly limits = new Map<RateLimitDimension, number>();
  readonly #counts = new Map<string, number>();

  consume(dimension: RateLimitDimension, subject: Buffer): Promise<RateLimitDecision> {
    const key = `${dimension}:${subject.toString('hex')}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return Promise.resolve(this.#decide(dimension, count));
  }

  peek(dimension: RateLimitDimension, subject: Buffer): Promise<RateLimitDecision> {
    const count = this.#counts.get(`${dimension}:${subject.toString('hex')}`) ?? 0;
    return Promise.resolve(this.#decide(dimension, count + 1));
  }

  #decide(dimension: RateLimitDimension, count: number): RateLimitDecision {
    const limit = this.limits.get(dimension) ?? 1_000_000;
    return count <= limit
      ? { allowed: true, remaining: limit - count }
      : { allowed: false, retryAfterSeconds: 60 };
  }
}

class CapturingDelivery implements OtpDeliveryPort {
  readonly sent: DeliveryRequest[] = [];
  next: DeliveryOutcome | 'THROW' = {
    kind: 'SENT',
    providerAlias: 'synthetic',
    providerMessageId: 'm-1',
  };

  send(request: DeliveryRequest): Promise<DeliveryOutcome> {
    this.sent.push(request);
    if (this.next === 'THROW') return Promise.reject(new Error('provider down'));
    return Promise.resolve(this.next);
  }

  codeFor(challengeId: string): string {
    const request = [...this.sent].reverse().find((entry) => entry.reference === challengeId);
    if (!request?.code) throw new Error('no code delivered');
    return request.code;
  }
}

class CountingAccountLookup implements ContactAccountLookup {
  calls = 0;
  readonly registered = new Set<string>();

  exists(_sql: SqlExecutor, fingerprints: ContactFingerprintSet): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(this.registered.has(fingerprints.primary.bytes.toString('hex')));
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

function client(installation = 'installation-a'): ClientContext {
  return {
    installationCommitment: subjects.commit('installation', installation),
    networkCommitment: subjects.commit('network-prefix', '203.0.113.0/24'),
    correlationId: uuidV7.uuidV7(),
    locale: 'es-DO',
  };
}

let phoneSequence = 0;
const nextPhone = (): string => `+1809${String(5_550_000 + (phoneSequence += 1)).padStart(7, '0')}`;

describe('auth verification challenges on real PostgreSQL', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  let admin: Pool;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtimePool: Pool | undefined;
  let now = new Date('2026-11-03T12:00:00.000Z');
  const advance = (seconds: number): void => {
    now = new Date(now.getTime() + seconds * 1_000);
  };

  const runtime = (): Pool => {
    if (!runtimePool) throw new Error('runtime pool is not initialized');
    return runtimePool;
  };

  const build = () => {
    const rateLimiter = new MemoryRateLimiter();
    const delivery = new CapturingDelivery();
    const accounts = new CountingAccountLookup();
    const store = new PostgresChallengeStore();
    const tokens = new NodeOpaqueTokenCodec();
    const committer = new KeyedOtpCommitter(keyring);
    const generator = new RejectionSamplingOtpGenerator();
    const service = new DefaultVerificationChallengeService({
      transactions: transactionsOver(runtime()),
      normalizer,
      fingerprinter,
      subjects,
      rateLimiter,
      delivery,
      codes: {
        generate: () => generator.generate(),
        commit: (id, purpose, code) => committer.commit(id, purpose, code),
        matches: (id, purpose, candidate, stored) =>
          committer.matches(id, purpose, candidate, stored),
      },
      tokens,
      store,
      accounts,
      ids: uuidV7,
      clock: { now: () => now },
      policy,
    });
    const consumer = new DefaultContactProofConsumer(normalizer, fingerprinter, tokens, store);
    return { service, consumer, rateLimiter, delivery, accounts };
  };

  const startChallenge = async (
    harness: ReturnType<typeof build>,
    phone: string,
    purpose: ChallengePurpose = 'CONTACT_PROOF',
    context: ClientContext = client(),
  ): Promise<string> => {
    const result = await harness.service.start({ purpose, phoneInput: phone, client: context });
    if (result.kind !== 'ACCEPTED') throw new Error(`start not accepted: ${result.kind}`);
    return result.challengeId;
  };

  const challengeRow = async (id: string) =>
    (
      await admin.query<{
        state: string;
        failed_attempts: number;
        resend_count: number;
        delivery_outcome_code: string | null;
        otp_commitment: Buffer;
      }>(
        'SELECT state, failed_attempts, resend_count, delivery_outcome_code, otp_commitment FROM auth.verification_challenges WHERE id = $1',
        [id],
      )
    ).rows[0];

  const consume = (
    harness: ReturnType<typeof build>,
    proofToken: unknown,
    phone: unknown,
    overrides: { purpose?: ChallengePurpose; installation?: string; consumedAt?: Date } = {},
  ) =>
    transactionsOver(runtime()).inTransaction((sql) =>
      harness.consumer.consume(sql, {
        proofToken,
        phoneInput: phone,
        purpose: overrides.purpose ?? 'CONTACT_PROOF',
        installationCommitment: subjects.commit(
          'installation',
          overrides.installation ?? 'installation-a',
        ),
        consumedAt: overrides.consumedAt ?? now,
      }),
    );

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_auth_challenge');
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

  it('verifies a code into one single-use proof bound to purpose, destination, and installation', async () => {
    const harness = build();
    const phone = nextPhone();
    harness.accounts.registered.add(
      fingerprinter
        .fingerprint({ profile: 'e164-v1', canonical: phone })
        .primary.bytes.toString('hex'),
    );
    const challengeId = await startChallenge(harness, phone);
    expect(harness.delivery.sent).toHaveLength(1);
    expect(harness.delivery.sent[0]).toMatchObject({
      template: 'OTP_CODE',
      locale: 'es-DO',
      reference: challengeId,
    });
    expect(harness.delivery.sent[0]?.destination.canonical).toBe(phone);

    const stored = await admin.query<Record<string, unknown>>(
      'SELECT * FROM auth.verification_challenges WHERE id = $1',
      [challengeId],
    );
    const serialized = JSON.stringify(stored.rows[0], (_key, value: unknown) =>
      value &&
      typeof value === 'object' &&
      'type' in value &&
      (value as { type: unknown }).type === 'Buffer'
        ? Buffer.from((value as { data: number[] }).data).toString('hex')
        : value,
    );
    expect(serialized).not.toContain(phone.slice(1));
    expect(serialized).not.toContain(harness.delivery.codeFor(challengeId));
    expect(stored.rows[0]?.delivery_outcome_code).toBe('SENT');

    const verified = await harness.service.verify({
      challengeId,
      code: harness.delivery.codeFor(challengeId),
      client: client(),
    });
    expect(verified.kind).toBe('VERIFIED');
    if (verified.kind !== 'VERIFIED') return;
    expect(verified.proofToken).toMatch(/^tvp_[A-Za-z0-9_-]{43}$/u);
    expect(verified.accountExists).toBe(true);
    expect(verified.proofExpiresAt).toEqual(new Date(now.getTime() + 600_000));
    const proofs = await admin.query<{ proof_hash: Buffer }>(
      'SELECT proof_hash FROM auth.contact_proofs WHERE challenge_id = $1',
      [challengeId],
    );
    expect(proofs.rows).toHaveLength(1);
    expect(proofs.rows[0]?.proof_hash.toString('utf8')).not.toContain(verified.proofToken);

    // Verify is safe to retry: the verified challenge answers CHALLENGE_NOT_ACTIVE and changes nothing.
    await expect(
      harness.service.verify({
        challengeId,
        code: harness.delivery.codeFor(challengeId),
        client: client(),
      }),
    ).resolves.toEqual({
      kind: 'CHALLENGE_NOT_ACTIVE',
    });

    const consumed = await consume(harness, verified.proofToken, phone);
    expect(consumed.kind).toBe('CONSUMED');
    expect((await challengeRow(challengeId))?.state).toBe('CONSUMED');
    await expect(consume(harness, verified.proofToken, phone)).resolves.toEqual({
      kind: 'PROOF_REJECTED',
    });
  });

  it('rejects a proof for another purpose, installation, number, after expiry, or malformed, changing nothing', async () => {
    const harness = build();
    const phone = nextPhone();
    const challengeId = await startChallenge(harness, phone);
    const verified = await harness.service.verify({
      challengeId,
      code: harness.delivery.codeFor(challengeId),
      client: client(),
    });
    if (verified.kind !== 'VERIFIED') throw new Error('not verified');
    expect(verified.accountExists).toBe(false);

    const attempts = [
      consume(harness, verified.proofToken, phone, { purpose: 'STEP_UP' }),
      consume(harness, verified.proofToken, phone, { installation: 'installation-b' }),
      consume(harness, verified.proofToken, nextPhone()),
      consume(harness, verified.proofToken, phone, {
        consumedAt: new Date(now.getTime() + 600_000),
      }),
      consume(harness, `${verified.proofToken.slice(0, -1)}A`, phone),
      consume(harness, verified.proofToken.replace('tvp_', 'tva_'), phone),
      consume(harness, verified.proofToken, 'not-a-phone'),
    ];
    for (const result of await Promise.all(attempts))
      expect(result).toEqual({ kind: 'PROOF_REJECTED' });
    const unchanged = await admin.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM auth.contact_proofs WHERE challenge_id = $1',
      [challengeId],
    );
    expect(unchanged.rows[0]?.consumed_at).toBeNull();
    expect((await challengeRow(challengeId))?.state).toBe('VERIFIED');
    // The proof is still usable by its legitimate holder until expiry.
    expect(
      (
        await consume(harness, verified.proofToken, phone, {
          consumedAt: new Date(now.getTime() + 599_000),
        })
      ).kind,
    ).toBe('CONSUMED');
  });

  it('cancels the previous PENDING challenge for the same destination and purpose only', async () => {
    const harness = build();
    const phone = nextPhone();
    const first = await startChallenge(harness, phone);
    const otherPurpose = await startChallenge(harness, phone, 'STEP_UP');
    const second = await startChallenge(harness, phone);
    expect((await challengeRow(first))?.state).toBe('CANCELLED');
    expect((await challengeRow(otherPurpose))?.state).toBe('PENDING');
    expect((await challengeRow(second))?.state).toBe('PENDING');
    await expect(
      harness.service.verify({
        challengeId: first,
        code: harness.delivery.codeFor(first),
        client: client(),
      }),
    ).resolves.toEqual({
      kind: 'CHALLENGE_NOT_ACTIVE',
    });
  });

  it('keeps exactly one PENDING challenge when 50 starts for one number race', async () => {
    const harness = build();
    const phone = nextPhone();
    const ids = await Promise.all(Array.from({ length: 50 }, () => startChallenge(harness, phone)));
    const pending = await admin.query<{ id: string }>(
      `SELECT id FROM auth.verification_challenges WHERE id = ANY($1::uuid[]) AND state = 'PENDING'`,
      [ids],
    );
    expect(pending.rows).toHaveLength(1);
  });

  it('exhausts at the attempt cap, expires at the code lifetime, and binds to the installation', async () => {
    const harness = build();
    const exhausted = await startChallenge(harness, nextPhone());
    const code = harness.delivery.codeFor(exhausted);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        harness.service.verify({ challengeId: exhausted, code: wrong, client: client() }),
      ).resolves.toEqual({
        kind: 'VERIFICATION_FAILED',
      });
    }
    expect(await challengeRow(exhausted)).toMatchObject({ state: 'EXHAUSTED', failed_attempts: 5 });
    await expect(
      harness.service.verify({ challengeId: exhausted, code, client: client() }),
    ).resolves.toEqual({ kind: 'CHALLENGE_NOT_ACTIVE' });

    const otherDevice = await startChallenge(harness, nextPhone());
    await expect(
      harness.service.verify({
        challengeId: otherDevice,
        code: harness.delivery.codeFor(otherDevice),
        client: client('installation-b'),
      }),
    ).resolves.toEqual({ kind: 'CHALLENGE_NOT_ACTIVE' });
    await expect(
      harness.service.verify({ challengeId: uuidV7.uuidV7(), code: '123456', client: client() }),
    ).resolves.toEqual({ kind: 'CHALLENGE_NOT_ACTIVE' });

    const expiring = await startChallenge(harness, nextPhone());
    advance(300);
    await expect(
      harness.service.verify({
        challengeId: expiring,
        code: harness.delivery.codeFor(expiring),
        client: client(),
      }),
    ).resolves.toEqual({ kind: 'CHALLENGE_NOT_ACTIVE' });
    expect((await challengeRow(expiring))?.state).toBe('EXPIRED');
  });

  it('stops verification once the contact failure budget is spent, without counting an attempt', async () => {
    const harness = build();
    harness.rateLimiter.limits.set('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', 2);
    const phone = nextPhone();
    const first = await startChallenge(harness, phone);
    const wrong = harness.delivery.codeFor(first) === '000000' ? '000001' : '000000';
    await harness.service.verify({ challengeId: first, code: wrong, client: client() });
    await harness.service.verify({ challengeId: first, code: wrong, client: client() });
    await expect(
      harness.service.verify({
        challengeId: first,
        code: harness.delivery.codeFor(first),
        client: client(),
      }),
    ).resolves.toEqual({
      kind: 'RATE_LIMITED',
      retryAfterSeconds: 60,
    });
    expect(await challengeRow(first)).toMatchObject({ state: 'PENDING', failed_attempts: 2 });
  });

  it('resends a fresh code after the cooldown, up to the resend cap, for the same number only', async () => {
    const harness = build();
    const phone = nextPhone();
    const challengeId = await startChallenge(harness, phone);
    const firstCode = harness.delivery.codeFor(challengeId);
    const firstCommitment = (await challengeRow(challengeId))?.otp_commitment;

    await expect(
      harness.service.resend({ challengeId, phoneInput: phone, client: client() }),
    ).resolves.toEqual({
      kind: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    });
    await expect(
      harness.service.resend({ challengeId, phoneInput: nextPhone(), client: client() }),
    ).resolves.toEqual({
      kind: 'CHALLENGE_NOT_ACTIVE',
    });
    for (let resend = 1; resend <= 3; resend += 1) {
      advance(30);
      const result = await harness.service.resend({
        challengeId,
        phoneInput: phone,
        client: client(),
      });
      expect(result).toEqual({
        kind: 'ACCEPTED',
        resendAvailableAt: new Date(now.getTime() + 30_000),
      });
    }
    advance(30);
    await expect(
      harness.service.resend({ challengeId, phoneInput: phone, client: client() }),
    ).resolves.toEqual({
      kind: 'CHALLENGE_NOT_ACTIVE',
    });
    const row = await challengeRow(challengeId);
    expect(row?.resend_count).toBe(3);
    expect(row?.otp_commitment.equals(firstCommitment ?? Buffer.alloc(0))).toBe(false);
    expect(harness.delivery.sent.filter((entry) => entry.reference === challengeId)).toHaveLength(
      4,
    );

    const latest = harness.delivery.codeFor(challengeId);
    if (latest !== firstCode) {
      await expect(
        harness.service.verify({ challengeId, code: firstCode, client: client() }),
      ).resolves.toEqual({
        kind: 'VERIFICATION_FAILED',
      });
    }
    expect(
      (await harness.service.verify({ challengeId, code: latest, client: client() })).kind,
    ).toBe('VERIFIED');
  });

  it('answers network and installation limits with RATE_LIMITED and silences contact limits', async () => {
    const network = build();
    network.rateLimiter.limits.set('CHALLENGE_START_NETWORK_HOUR', 0);
    const before = Number(
      (await admin.query<{ count: string }>('SELECT count(*) FROM auth.verification_challenges'))
        .rows[0]?.count,
    );
    await expect(
      network.service.start({
        purpose: 'CONTACT_PROOF',
        phoneInput: nextPhone(),
        client: client(),
      }),
    ).resolves.toEqual({
      kind: 'RATE_LIMITED',
      retryAfterSeconds: 60,
    });
    const installation = build();
    installation.rateLimiter.limits.set('CHALLENGE_START_INSTALLATION_HOUR', 0);
    expect(
      (
        await installation.service.start({
          purpose: 'CONTACT_PROOF',
          phoneInput: nextPhone(),
          client: client(),
        })
      ).kind,
    ).toBe('RATE_LIMITED');

    const contact = build();
    contact.rateLimiter.limits.set('CHALLENGE_START_CONTACT_HOUR', 1);
    const phone = nextPhone();
    const allowed = await contact.service.start({
      purpose: 'CONTACT_PROOF',
      phoneInput: phone,
      client: client(),
    });
    const silenced = await contact.service.start({
      purpose: 'CONTACT_PROOF',
      phoneInput: phone,
      client: client(),
    });
    expect(Object.keys(silenced).sort()).toEqual(Object.keys(allowed).sort());
    expect(silenced.kind).toBe('ACCEPTED');
    expect(contact.delivery.sent).toHaveLength(1);
    if (allowed.kind === 'ACCEPTED')
      expect((await challengeRow(allowed.challengeId))?.state).toBe('PENDING');
    if (silenced.kind === 'ACCEPTED')
      expect(await challengeRow(silenced.challengeId)).toBeUndefined();
    const after = Number(
      (await admin.query<{ count: string }>('SELECT count(*) FROM auth.verification_challenges'))
        .rows[0]?.count,
    );
    expect(after).toBe(before + 1);

    // R-21: no start, silenced or not, consulted account or contact-binding state.
    expect(network.accounts.calls + installation.accounts.calls + contact.accounts.calls).toBe(0);
    await expect(
      network.service.start({
        purpose: 'CONTACT_PROOF',
        phoneInput: '8095550100',
        client: client(),
      }),
    ).resolves.toEqual({
      kind: 'INVALID_CONTACT_FORMAT',
      code: 'INVALID_LENGTH',
    });
  });

  it('still accepts the start and records a safe outcome when delivery fails', async () => {
    const harness = build();
    harness.delivery.next = { kind: 'NOT_SENT', safeCode: 'BUDGET_EXHAUSTED' };
    const budget = await startChallenge(harness, nextPhone());
    expect((await challengeRow(budget))?.delivery_outcome_code).toBe('BUDGET_EXHAUSTED');
    harness.delivery.next = 'THROW';
    const thrown = await startChallenge(harness, nextPhone());
    expect((await challengeRow(thrown))?.delivery_outcome_code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('creates exactly one proof when 50 connections submit the correct code', async () => {
    const harness = build();
    const challengeId = await startChallenge(harness, nextPhone());
    const code = harness.delivery.codeFor(challengeId);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        harness.service.verify({ challengeId, code, client: client() }),
      ),
    );
    expect(results.filter((result) => result.kind === 'VERIFIED')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'CHALLENGE_NOT_ACTIVE')).toHaveLength(49);
    const proofs = await admin.query<{ count: string }>(
      'SELECT count(*) FROM auth.contact_proofs WHERE challenge_id = $1',
      [challengeId],
    );
    expect(Number(proofs.rows[0]?.count)).toBe(1);
  });

  it('never records more failures than the cap when 50 connections submit wrong codes', async () => {
    const harness = build();
    const challengeId = await startChallenge(harness, nextPhone());
    const code = harness.delivery.codeFor(challengeId);
    const wrong = code === '000000' ? '000001' : '000000';
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        harness.service.verify({ challengeId, code: wrong, client: client() }),
      ),
    );
    expect(results.filter((result) => result.kind === 'VERIFICATION_FAILED')).toHaveLength(5);
    expect(results.filter((result) => result.kind === 'CHALLENGE_NOT_ACTIVE')).toHaveLength(45);
    expect(await challengeRow(challengeId)).toMatchObject({
      state: 'EXHAUSTED',
      failed_attempts: 5,
    });
  });

  it('denies the runtime deletes and immutable-column writes, and the trigger guards every edge', async () => {
    const harness = build();
    const challengeId = await startChallenge(harness, nextPhone());
    const code = async (pool: Pool, statement: string, values: readonly unknown[]) => {
      try {
        await pool.query(statement, [...values]);
        return undefined;
      } catch (error: unknown) {
        const failure = error as { code?: string; constraint?: string };
        return failure.constraint ?? failure.code;
      }
    };
    expect(
      await code(runtime(), 'DELETE FROM auth.verification_challenges WHERE id = $1', [
        challengeId,
      ]),
    ).toBe('42501');
    expect(await code(runtime(), 'DELETE FROM auth.contact_proofs', [])).toBe('42501');
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET purpose = 'STEP_UP' WHERE id = $1`,
        [challengeId],
      ),
    ).toBe('42501');
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET expires_at = expires_at + interval '1 hour' WHERE id = $1`,
        [challengeId],
      ),
    ).toBe('42501');
    expect(
      await code(runtime(), 'UPDATE auth.contact_proofs SET expires_at = clock_timestamp()', []),
    ).toBe('42501');
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET failed_attempts = 0 WHERE id = $1`,
        [challengeId],
      ),
    ).toBeUndefined();
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET failed_attempts = failed_attempts + 2 WHERE id = $1`,
        [challengeId],
      ),
    ).toBe('verification_challenge_counters');
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET otp_commitment = $2 WHERE id = $1`,
        [challengeId, Buffer.alloc(32, 1)],
      ),
    ).toBe('verification_challenge_counters');
    expect(
      await code(
        runtime(),
        `UPDATE auth.verification_challenges SET state = 'CONSUMED' WHERE id = $1`,
        [challengeId],
      ),
    ).toBe('verification_challenge_lifecycle');
    expect(
      await code(
        admin,
        `UPDATE auth.verification_challenges SET state = 'CANCELLED' WHERE id = $1`,
        [challengeId],
      ),
    ).toBeUndefined();
    expect(
      await code(admin, `UPDATE auth.verification_challenges SET state = 'PENDING' WHERE id = $1`, [
        challengeId,
      ]),
    ).toBe('verification_challenge_lifecycle');
  });

  it('refuses to roll back migration 0014 while challenges exist', async () => {
    const versions = (await migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0014').reverse()) {
      expect(await migrator.down()).toEqual([version]);
    }
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0014');
    await migrator.up();
  });
});
