import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAuthHarness,
  deliveredCode,
  installation,
  nowSeconds,
  phone,
  sign,
  type AuthHarness,
} from './auth-harness';

const ALLOWED_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_CONTACT_FORMAT',
  'VERIFICATION_FAILED',
  'CHALLENGE_NOT_ACTIVE',
  'RATE_LIMITED',
  'CALLBACK_REJECTED',
  'REQUEST_CANNOT_BE_COMPLETED',
]);

describe('SPEC-001 challenge and callback routes', () => {
  let harness: AuthHarness;
  const emittedCodes = new Set<string>();

  const post = async (
    url: string,
    payload: unknown,
    options: {
      installation?: string | undefined;
      ip?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...options.headers,
    };
    const device = 'installation' in options ? options.installation : installation();
    if (device !== undefined) headers['x-trayvi-installation'] = device;
    const response = await harness.runtime.app.inject({
      method: 'POST',
      url,
      headers,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      remoteAddress: options.ip ?? '192.0.2.10',
    });
    if (response.statusCode >= 400) {
      const body = response.json<{ code?: string }>();
      if (body.code) emittedCodes.add(body.code);
    }
    return response;
  };

  const start = (phoneNumber: unknown, device: string, ip?: string) =>
    post(
      '/api/v1/verification-challenges',
      { purpose: 'CONTACT_PROOF', phoneNumber, locale: 'es-DO' },
      {
        installation: device,
        ...(ip ? { ip } : {}),
      },
    );

  beforeAll(async () => {
    harness = await createAuthHarness({ AUTH_RATE_LIMIT_CHALLENGE_START_NETWORK_HOUR: '3' });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('starts, verifies, and proves a contact through the public routes', async () => {
    const device = installation();
    const number = phone();
    const started = await start(number, device, '198.51.1.1');
    expect(started.statusCode).toBe(202);
    const body = started.json<{
      code: string;
      challengeId: string;
      expiresAt: string;
      resendAvailableAt: string;
    }>();
    expect(Object.keys(body).sort()).toEqual([
      'challengeId',
      'code',
      'expiresAt',
      'resendAvailableAt',
    ]);
    expect(body.code).toBe('CHALLENGE_ACCEPTED');
    const code = deliveredCode(harness.services, body.challengeId);

    const wrong = await post(
      `/api/v1/verification-challenges/${body.challengeId}/verify`,
      { code: code === '000000' ? '000001' : '000000' },
      {
        installation: device,
        ip: '198.51.1.1',
      },
    );
    expect(wrong.statusCode).toBe(400);
    expect(wrong.headers['content-type']).toContain('application/problem+json');
    expect(wrong.json()).toMatchObject({
      type: 'about:blank',
      status: 400,
      code: 'VERIFICATION_FAILED',
    });

    const verified = await post(
      `/api/v1/verification-challenges/${body.challengeId}/verify`,
      { code },
      { installation: device, ip: '198.51.1.1' },
    );
    expect(verified.statusCode).toBe(200);
    const proof = verified.json<{
      proof: string;
      proofExpiresAt: string;
      accountExists: boolean;
    }>();
    expect(proof.proof).toMatch(/^tvp_[A-Za-z0-9_-]{43}$/u);
    expect(proof.accountExists).toBe(false);
    expect(Object.keys(proof).sort()).toEqual(['accountExists', 'proof', 'proofExpiresAt']);

    const again = await post(
      `/api/v1/verification-challenges/${body.challengeId}/verify`,
      { code },
      { installation: device, ip: '198.51.1.1' },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CHALLENGE_NOT_ACTIVE' });
  });

  it('exposes the normalization code only as a field error and rejects anything outside the strict schema', async () => {
    const invalid = await start('+12125550100', installation(), '198.51.2.2');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: 'INVALID_CONTACT_FORMAT',
      errors: [{ field: 'phoneNumber', code: 'UNSUPPORTED_REGION' }],
    });

    const malformed: readonly unknown[] = [
      { purpose: 'CONTACT_PROOF', phoneNumber: phone(), locale: 'es-DO', extra: true },
      { purpose: 'STEP_UP', phoneNumber: phone(), locale: 'es-DO' },
      { purpose: 'CONTACT_PROOF', phoneNumber: phone() },
      { purpose: 'CONTACT_PROOF', phoneNumber: phone(), locale: 'spanish' },
      [],
    ];
    for (const payload of malformed) {
      const response = await post('/api/v1/verification-challenges', payload, {
        ip: '198.51.2.3',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    const missingDevice = await post(
      '/api/v1/verification-challenges',
      { purpose: 'CONTACT_PROOF', phoneNumber: phone(), locale: 'es-DO' },
      {
        installation: undefined,
        ip: '198.51.2.4',
      },
    );
    expect(missingDevice.json()).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
    const badId = await post(
      '/api/v1/verification-challenges/not-a-uuid/verify',
      { code: '123456' },
      { ip: '198.51.2.4' },
    );
    expect(badId.json()).toMatchObject({ status: 409, code: 'CHALLENGE_NOT_ACTIVE' });
  });

  it('answers the resend cooldown and the network limit with 429 and Retry-After', async () => {
    const device = installation();
    const number = phone();
    const started = (await start(number, device, '198.51.3.5')).json<{ challengeId: string }>();
    const cooldown = await post(
      `/api/v1/verification-challenges/${started.challengeId}/resend`,
      { phoneNumber: number },
      {
        installation: device,
        ip: '198.51.3.5',
      },
    );
    expect(cooldown.statusCode).toBe(429);
    expect(cooldown.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(cooldown.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // The network hour limit is 3 here: start + resend above already spent 2 units for 198.51.3.0/24.
    expect((await start(phone(), installation(), '198.51.3.6')).statusCode).toBe(202);
    const limited = await start(phone(), installation(), '198.51.3.7');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another /24 is unaffected.
    expect((await start(phone(), installation(), '203.0.113.8')).statusCode).toBe(202);
  });

  it('accepts signed callbacks, replays them as a no-op, and rejects every failure with one 401', async () => {
    const started = (await start(phone(), installation(), '203.0.113.20')).json<{
      challengeId: string;
    }>();
    const callback = (
      body: Buffer,
      options: {
        alias?: string;
        timestamp?: string;
        signature?: string;
        contentType?: string;
      } = {},
    ) => {
      const timestamp = options.timestamp ?? nowSeconds();
      return harness.runtime.app.inject({
        method: 'POST',
        url: `/api/v1/provider-callbacks/${options.alias ?? 'synthetic'}/delivery-status`,
        headers: {
          'content-type': options.contentType ?? 'application/json',
          'x-trayvi-timestamp': timestamp,
          'x-trayvi-signature': options.signature ?? sign(timestamp, body),
        },
        payload: body,
      });
    };
    const raw = Buffer.from(
      JSON.stringify({
        providerEventId: 'dlr-route-1',
        reference: started.challengeId,
        status: 'DELIVERED',
      }),
    );
    const accepted = await callback(raw);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({});
    const stored = await harness.admin.query<{ code: string }>(
      'SELECT delivery_outcome_code AS code FROM auth.verification_challenges WHERE id = $1',
      [started.challengeId],
    );
    expect(stored.rows[0]?.code).toBe('DELIVERED');
    expect((await callback(raw)).statusCode).toBe(200);

    // A non-JSON content type is accepted: the route reads raw bytes and parses only after verifying.
    const plain = Buffer.from(
      JSON.stringify({
        providerEventId: 'dlr-route-2',
        reference: started.challengeId,
        status: 'DELIVERED',
      }),
    );
    expect((await callback(plain, { contentType: 'text/plain' })).statusCode).toBe(200);

    const stale = String(Number(nowSeconds()) - 600);
    const rejections = await Promise.all([
      callback(raw, { alias: 'unknown' }),
      callback(raw, { signature: `v1=${'0'.repeat(64)}` }),
      callback(raw, { timestamp: stale, signature: sign(stale, raw) }),
      // Invalid JSON with a bad signature must not surface a parse error.
      callback(Buffer.from('{not json'), { signature: `v1=${'1'.repeat(64)}` }),
      // Invalid JSON with a valid signature is still one 401.
      callback(Buffer.from('{not json')),
      callback(Buffer.concat([raw, Buffer.alloc(17_000, 0x20)])),
    ]);
    for (const response of rejections) {
      expect(response.statusCode).toBe(401);
      const body = response.json<Record<string, unknown>>();
      emittedCodes.add(String(body.code));
      expect({ ...body, requestId: 'x' }).toEqual({
        type: 'about:blank',
        title: 'Callback rejected',
        status: 401,
        code: 'CALLBACK_REJECTED',
        requestId: 'x',
      });
    }
  });

  it('emits only the Problem Details codes listed for SPEC-001', () => {
    expect(emittedCodes.size).toBeGreaterThan(0);
    for (const code of emittedCodes) expect(ALLOWED_CODES.has(code)).toBe(true);
  });
});
