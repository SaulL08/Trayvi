import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConfiguredAuthKeyring,
  ContactEnvelopeCipher,
  E164PhoneNormalizer,
  HmacContactFingerprinter,
  PostgresContactPointCommands,
  type SqlExecutor,
} from '@trayvi/auth';
import { createOpaqueId } from '@trayvi/observability';

import { syntheticAuthKeys } from '../../src/auth/synthetic-keys';

import { createAuthHarness, installation, type AuthHarness } from './auth-harness';

const SAMPLES = 200;
// Headers whose values legitimately differ per request; their presence is still compared.
const PER_REQUEST_HEADERS = new Set(['x-request-id', 'x-correlation-id', 'date']);

type Class = 'registered' | 'unregistered' | 'contactLimited';

interface Sample {
  readonly status: number;
  readonly keys: string;
  readonly headers: string;
  readonly size: number;
  readonly milliseconds: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

describe('SPEC-001 challenge start enumeration oracle (R-19, R-21, R-22)', () => {
  let harness: AuthHarness;
  const numbers: Record<Class, string[]> = { registered: [], unregistered: [], contactLimited: [] };

  const start = (phoneNumber: string) =>
    harness.runtime.app.inject({
      method: 'POST',
      url: '/api/v1/verification-challenges',
      headers: { 'content-type': 'application/json', 'x-trayvi-installation': installation() },
      payload: JSON.stringify({ purpose: 'CONTACT_PROOF', phoneNumber, locale: 'es-DO' }),
      remoteAddress: '192.0.2.50',
    });

  beforeAll(async () => {
    harness = await createAuthHarness({
      // One start per number per hour, so a second start is contact-limited (silenced).
      AUTH_RATE_LIMIT_CHALLENGE_START_CONTACT_HOUR: '1',
      AUTH_RATE_LIMIT_CHALLENGE_START_NETWORK_HOUR: '100000',
      AUTH_RATE_LIMIT_CHALLENGE_START_INSTALLATION_HOUR: '100000',
      AUTH_RATE_LIMIT_DELIVERY_GLOBAL_MINUTE: '100000',
    });
    for (let index = 0; index < SAMPLES; index += 1) {
      numbers.registered.push(`+1809${String(1_000_000 + index).padStart(7, '0')}`);
      numbers.unregistered.push(`+1829${String(2_000_000 + index).padStart(7, '0')}`);
      numbers.contactLimited.push(`+1849${String(3_000_000 + index).padStart(7, '0')}`);
    }

    // Registered numbers: bind each to its own account with the same synthetic keys as the app.
    const keyring = new ConfiguredAuthKeyring(syntheticAuthKeys());
    const normalizer = new E164PhoneNormalizer({
      defaultCallingCode: '1',
      callingCodes: [
        { code: '1', nationalNumberLength: 10, destinationCodes: ['809', '829', '849'] },
      ],
    });
    const fingerprinter = new HmacContactFingerprinter(keyring);
    const contacts = new PostgresContactPointCommands(new ContactEnvelopeCipher(keyring), {
      uuidV7: createOpaqueId,
    });
    const client = await harness.admin.connect();
    const sql: SqlExecutor = {
      query: async <Row extends object>(text: string, values: readonly unknown[]) => {
        const result = await client.query<Row>(text, [...values]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      for (const number of numbers.registered) {
        const normalized = normalizer.normalize(number);
        if (!normalized.ok) throw new Error('fixture number invalid');
        const accountId = createOpaqueId();
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO accounts.accounts (id, status, status_reason_code, version, created_at, updated_at)
           VALUES ($1, 'PENDING_IDENTITY', 'ENROLLMENT_STARTED', 0, clock_timestamp(), clock_timestamp())`,
          [accountId],
        );
        await client.query(
          `INSERT INTO accounts.account_status_transitions (
             id, account_id, from_status, to_status, aggregate_version,
             actor_class, actor_reference, reason_code, evidence_reference, occurred_at
           ) VALUES ($1, $2, NULL, 'PENDING_IDENTITY', 0, 'ENROLLMENT_SERVICE', 'oracle-test',
             'ENROLLMENT_STARTED', $3, clock_timestamp())`,
          [createOpaqueId(), accountId, createOpaqueId()],
        );
        const bound = await contacts.bindPrimary(sql, {
          accountId,
          phone: normalized.value,
          fingerprints: fingerprinter.fingerprint(normalized.value),
          reason: 'REGISTRATION',
          occurredAt: new Date(),
          correlationId: createOpaqueId(),
        });
        if (bound.kind !== 'BOUND') throw new Error('fixture binding failed');
        await client.query('COMMIT');
      }
    } finally {
      client.release();
    }

    // Contact-limited numbers: spend their one allowed start before measuring.
    for (const number of numbers.contactLimited) expect((await start(number)).statusCode).toBe(202);
    // Warm up code paths so the first measured class does not pay JIT and pool start-up costs.
    for (let index = 0; index < 20; index += 1)
      await start(`+1809${String(4_000_000 + index).padStart(7, '0')}`);
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  it('returns indistinguishable responses for registered, unregistered, and contact-limited numbers', async () => {
    const samples: Record<Class, Sample[]> = {
      registered: [],
      unregistered: [],
      contactLimited: [],
    };
    const classes: readonly Class[] = ['registered', 'unregistered', 'contactLimited'];
    // Interleave classes so drift (GC, pool warm-up) affects all of them alike.
    for (let index = 0; index < SAMPLES; index += 1) {
      for (const kind of index % 2 === 0 ? classes : [...classes].reverse()) {
        const startedAt = performance.now();
        const response = await start(numbers[kind][index] ?? '');
        const milliseconds = performance.now() - startedAt;
        samples[kind].push({
          status: response.statusCode,
          keys: Object.keys(response.json<Record<string, unknown>>()).sort().join(','),
          headers: Object.keys(response.headers)
            .map((name) => name.toLowerCase())
            .sort()
            .map((name) =>
              PER_REQUEST_HEADERS.has(name) ? name : `${name}=${String(response.headers[name])}`,
            )
            .join('|'),
          size: response.body.length,
          milliseconds,
        });
      }
    }

    const reference = samples.unregistered[0];
    for (const kind of classes) {
      expect(samples[kind]).toHaveLength(SAMPLES);
      for (const sample of samples[kind]) {
        expect(sample.status).toBe(202);
        expect(sample.keys).toBe(reference?.keys);
        expect(sample.headers).toBe(reference?.headers);
        // Fixed-length fields (UUID, ISO timestamps) make the size class a single size.
        expect(sample.size).toBe(reference?.size);
      }
    }
    const medians = Object.fromEntries(
      classes.map((kind) => [kind, median(samples[kind].map((sample) => sample.milliseconds))]),
    );
    const spread = Math.max(...Object.values(medians)) - Math.min(...Object.values(medians));
    // Design §6: median timing difference under 20 ms.
    expect(spread, JSON.stringify(medians)).toBeLessThan(20);
  }, 180_000);
});
