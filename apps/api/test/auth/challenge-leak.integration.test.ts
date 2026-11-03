import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StructuredLogger } from '@trayvi/observability';

import {
  createAuthHarness,
  deliveredCode,
  installation,
  nowSeconds,
  sign,
  type AuthHarness,
} from './auth-harness';

const CANARY_PHONE = '+18095550123';
const CANARY_DIGITS = '8095550123';

/** Hex-aware boundary so a 6-digit code is not "found" inside an unrelated hex or digit run. */
function containsCode(haystack: string, code: string): boolean {
  return new RegExp(`(?<![0-9a-fA-F])${code}(?![0-9a-fA-F])`, 'u').test(haystack);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith('.ts') ? [path] : []);
    }),
  );
  return files.flat();
}

describe('SPEC-001 canary leak capture (R-23, R-31)', () => {
  let harness: AuthHarness;
  let logs = '';
  const responses: string[] = [];
  let code = '';
  let proof = '';

  const post = async (url: string, payload: string, headers: Record<string, string> = {}) => {
    const response = await harness.runtime.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
      remoteAddress: '192.0.2.77',
    });
    return response;
  };

  beforeAll(async () => {
    const destination = new PassThrough();
    destination.on('data', (chunk: Buffer) => {
      logs += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'integration',
      level: 'debug',
      format: 'json',
      destination,
    });
    harness = await createAuthHarness({}, logger);

    const device = installation();
    const record = (response: Awaited<ReturnType<typeof post>>) => {
      responses.push(JSON.stringify(response.headers), response.body);
      return response;
    };
    const started = record(
      await post(
        '/api/v1/verification-challenges',
        JSON.stringify({ purpose: 'CONTACT_PROOF', phoneNumber: CANARY_PHONE, locale: 'es-DO' }),
        { 'x-trayvi-installation': device },
      ),
    );
    const challengeId = started.json<{ challengeId: string }>().challengeId;
    code = deliveredCode(harness.services, challengeId);
    record(
      await post(
        `/api/v1/verification-challenges/${challengeId}/verify`,
        JSON.stringify({ code: code === '000000' ? '000001' : '000000' }),
        { 'x-trayvi-installation': device },
      ),
    );
    record(
      await post(
        `/api/v1/verification-challenges/${challengeId}/resend`,
        JSON.stringify({ phoneNumber: CANARY_PHONE }),
        { 'x-trayvi-installation': device },
      ),
    );
    // Unknown field, malformed JSON, and a missing installation header all carry the canary.
    record(
      await post(
        '/api/v1/verification-challenges',
        JSON.stringify({
          purpose: 'CONTACT_PROOF',
          phoneNumber: CANARY_PHONE,
          locale: 'es-DO',
          code,
        }),
        { 'x-trayvi-installation': device },
      ),
    );
    record(
      await post(
        '/api/v1/verification-challenges',
        `{"phoneNumber":"${CANARY_PHONE}","code":"${code}"`,
        { 'x-trayvi-installation': device },
      ),
    );
    record(
      await post(
        '/api/v1/verification-challenges',
        JSON.stringify({ purpose: 'CONTACT_PROOF', phoneNumber: CANARY_PHONE, locale: 'es-DO' }),
      ),
    );
    // A signed callback whose body repeats the number and the code in non-allowlisted fields.
    const body = Buffer.from(
      JSON.stringify({
        providerEventId: 'dlr-leak-1',
        reference: challengeId,
        status: 'DELIVERED',
        destination: CANARY_PHONE,
        text: `Tu código es ${code}`,
      }),
    );
    const timestamp = nowSeconds();
    record(
      await post('/api/v1/provider-callbacks/synthetic/delivery-status', body.toString('utf8'), {
        'x-trayvi-timestamp': timestamp,
        'x-trayvi-signature': sign(timestamp, body),
      }),
    );
    record(
      await post('/api/v1/provider-callbacks/synthetic/delivery-status', body.toString('utf8'), {
        'x-trayvi-timestamp': timestamp,
        'x-trayvi-signature': `v1=${'0'.repeat(64)}`,
      }),
    );

    // The correct code: its response legitimately carries the proof, so it is checked separately.
    const verified = await post(
      `/api/v1/verification-challenges/${challengeId}/verify`,
      JSON.stringify({ code }),
      { 'x-trayvi-installation': device },
    );
    expect(verified.statusCode).toBe(200);
    proof = verified.json<{ proof: string }>().proof;
    responses.push(JSON.stringify(verified.headers));
    harness.runtime.logger.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  it('keeps the number, code, and proof out of logs', () => {
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(CANARY_DIGITS);
    expect(containsCode(logs, code)).toBe(false);
    expect(logs).not.toContain(proof);
  });

  it('keeps the number, code, and proof out of every response, header, and Problem Details body', () => {
    const serialized = responses.join('\n');
    expect(serialized).not.toContain(CANARY_DIGITS);
    expect(containsCode(serialized, code)).toBe(false);
    expect(serialized).not.toContain(proof);
  });

  it('keeps them out of metrics, the outbox, and every Auth table', async () => {
    const metrics = JSON.stringify(harness.runtime.metrics.snapshot());
    expect(metrics).not.toContain(CANARY_DIGITS);
    expect(containsCode(metrics, code)).toBe(false);

    const dump = async (table: string) =>
      JSON.stringify(
        (await harness.admin.query(`SELECT * FROM ${table}`)).rows,
        (_key, value: unknown) =>
          value &&
          typeof value === 'object' &&
          'type' in value &&
          (value as { type: unknown }).type === 'Buffer'
            ? Buffer.from((value as { data: number[] }).data).toString('hex')
            : value,
      );
    for (const table of [
      'platform.outbox_events',
      'auth.verification_challenges',
      'auth.contact_proofs',
      'auth.provider_callback_receipts',
      'auth.rate_limit_buckets',
      'auth.contact_points',
    ]) {
      const rows = await dump(table);
      expect(rows, table).not.toContain(CANARY_DIGITS);
      expect(rows, table).not.toContain(Buffer.from(CANARY_PHONE).toString('hex'));
      expect(containsCode(rows, code), table).toBe(false);
      expect(rows, table).not.toContain(proof);
    }
  });

  it('adds no span attributes or events from Auth code (spans carry only method and status)', async () => {
    // Telemetry export is disabled in tests and an in-memory exporter would need a new dependency;
    // instead prove no Auth source writes to a span, so spans keep the bootstrap's safe attributes.
    const roots = [resolve('modules/auth/src'), resolve('apps/api/src/auth')];
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(
        /@opentelemetry|\.(?:setAttributes?|addEvent|startSpan|startActiveSpan|recordException)\(/u,
      );
    }
  });
});
