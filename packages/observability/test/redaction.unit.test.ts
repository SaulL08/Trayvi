import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { sanitizeForLogging, StructuredLogger } from '../src';

describe('recursive log redaction', () => {
  it('redacts the complete sensitive corpus recursively and case-insensitively', () => {
    const error = new Error('request failed with Bearer raw-access-token');
    error.cause = { ApiKey: 'api-key-canary', url: 'https://example.test/cb?otp=123456' };
    const circular: Record<string, unknown> = { Password: 'password-canary' };
    circular.self = circular;

    const sanitized = sanitizeForLogging({
      password: 'password-canary',
      PASSCODE: 'passcode-canary',
      otp: 'otp-canary',
      Authorization: 'Bearer auth-canary',
      headers: { Cookie: 'session=cookie-canary', 'Set-Cookie': 'secret-cookie' },
      token: 'token-canary',
      refreshToken: 'refresh-canary',
      access_token: 'access-token-canary',
      SECRET: 'secret-canary',
      apiKey: 'api-key-canary',
      documentNumber: 'document-canary',
      national_id: 'national-id-canary',
      document_number: 'document-number-canary',
      cedula: 'cedula-canary',
      cardNumber: '4111111111111111',
      cvv: '123',
      bankAccount: 'bank-canary',
      payment_credentials: 'payment-credentials-canary',
      latitude: 18.44,
      nested: [{ query: 'https://example.test/path?token=query-canary&safe=no' }],
      database: 'postgresql://user:database-canary@example.test/db',
      error,
      circular,
    });
    const output = JSON.stringify(sanitized);

    for (const canary of [
      'password-canary',
      'passcode-canary',
      'otp-canary',
      'auth-canary',
      'cookie-canary',
      'token-canary',
      'refresh-canary',
      'access-token-canary',
      'secret-canary',
      'api-key-canary',
      'document-canary',
      'national-id-canary',
      'document-number-canary',
      'cedula-canary',
      '4111111111111111',
      'bank-canary',
      'payment-credentials-canary',
      'database-canary',
      'query-canary',
    ]) {
      expect(output).not.toContain(canary);
    }
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[CIRCULAR]');
  });

  it('applies redaction on the final structured logger boundary', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'unit-test',
      environment: 'test',
      version: 'test',
      level: 'info',
      format: 'json',
      destination: stream,
    });

    logger.info('redaction.checked', { nested: { ReFrEsHtOkEn: 'final-boundary-canary' } });
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain('final-boundary-canary');
    expect(JSON.parse(output)).toMatchObject({
      service: 'unit-test',
      event: 'redaction.checked',
    });
  });

  it('redacts a database protocol secret key from final error output', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'test',
      level: 'error',
      format: 'json',
      destination: stream,
    });
    const protocolSecret = 1_353_585_937;
    const databaseError = Object.assign(new Error('database connection terminated'), {
      client: { secretKey: protocolSecret },
    });

    logger.error('database.pool.error', databaseError);
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain(String(protocolSecret));
    expect(JSON.parse(output)).toMatchObject({
      error: { client: { secretKey: '[REDACTED]' } },
    });
  });

  it('redacts structured sensitive assignments from error messages, stacks, causes, and metadata', () => {
    const canaries = [
      'message-canary',
      'stack-canary',
      'cause-canary',
      'nested-canary',
      'authorization-canary',
      'otp-canary',
      'national-id-canary',
      'cedula-canary',
    ];
    const error = new Error(
      `failed PASSWORD = "${canaries[0]}" token:${canaries[1]} authorization=Bearer ${canaries[4]}`,
    );
    error.stack = `Error: secret='${canaries[1]}'\n at harmless.ts:1:1`;
    error.cause = new Error(`Otp : ${canaries[2]}`);

    const output = JSON.stringify(
      sanitizeForLogging({
        error,
        metadata: {
          description: `national_id=${canaries[6]}; CEDULA: '${canaries[7]}'`,
          nested: [{ note: `client-secret: ${canaries[3]}` }],
          harmless: 'retry-after: 30',
        },
      }),
    );

    for (const canary of canaries) expect(output).not.toContain(canary);
    expect(output).toContain('retry-after: 30');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts sensitive error text at the direct logger boundary', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'worker',
      environment: 'test',
      version: 'test',
      level: 'info',
      format: 'json',
      destination: stream,
    });
    const canary = 'worker-error-text-canary';

    logger.error('worker.operation.failed', new Error(`password=${canary}`), {
      detail: `secret: "${canary}"`,
    });
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain(canary);
    expect(output).toContain('[REDACTED]');
  });

  it('sanitizes string-only and encoded secrets in final serialized Pino output', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'test',
      level: 'debug',
      format: 'json',
      destination: stream,
    });
    const canary = 'final-pino-canary';
    const variants = [
      `password=${canary}`,
      `password: ${canary}`,
      `password="${canary}"`,
      `"password":"${canary}"`,
      `?password=${canary}`,
      `&password=${canary}`,
      `password%3D${canary}`,
      `password%3A${canary}`,
      `PASSWORD%253D${canary}`,
      `ToKeN=${canary}`,
      `access_token=${canary}`,
      `refresh_token=${canary}`,
      `authorization: ${canary}`,
      `secret=${canary}`,
      `otp=${canary}`,
      `cedula=${canary}`,
      `national_id=${canary}`,
      `document_number=${canary}`,
    ];

    variants.forEach((variant, index) => logger.info(variant, { index }));
    logger.error(
      'aggregate.failed',
      new AggregateError([new Error(`password=${canary}`)], `token=${canary}`),
      { note: `secret=${canary}` },
    );
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).not.toContain(canary);
    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; message: string });
    expect(records).toHaveLength(variants.length + 1);
    expect(records.every((record) => record.event === record.message)).toBe(true);
    expect(records.some((record) => record.message.includes('[REDACTED]'))).toBe(true);
  });

  it('does not invoke getters while sanitizing objects or errors', () => {
    let getterCalls = 0;
    const hostile = Object.defineProperties(new Error('safe diagnostic'), {
      message: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error('getter-canary');
        },
      },
      metadata: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return 'metadata-canary';
        },
      },
    });

    const output = JSON.stringify(sanitizeForLogging({ hostile }));

    expect(getterCalls).toBe(0);
    expect(output).toContain('[ACCESSOR]');
    expect(output).not.toContain('getter-canary');
    expect(output).not.toContain('metadata-canary');
  });

  it('contains proxy reflection failures without throwing or exposing the source', () => {
    const canary = 'proxy-source-canary';
    const hostile = new Proxy(
      { value: canary },
      {
        ownKeys() {
          throw new Error('reflection failed');
        },
      },
    );

    expect(() => sanitizeForLogging(hostile)).not.toThrow();
    const output = JSON.stringify(sanitizeForLogging(hostile));
    expect(output).toBe('"[UNSANITIZABLE]"');
    expect(output).not.toContain(canary);
  });

  it('keeps the final logger available when metadata reflection fails', async () => {
    const stream = new PassThrough();
    let output = '';
    stream.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'unit-test',
      environment: 'test',
      version: 'test',
      level: 'info',
      format: 'json',
      destination: stream,
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('logger-reflection-canary');
        },
      },
    );

    expect(() => logger.info('hostile.checked', { hostile })).not.toThrow();
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(output).toContain('[UNSANITIZABLE]');
    expect(output).not.toContain('logger-reflection-canary');
  });
});
