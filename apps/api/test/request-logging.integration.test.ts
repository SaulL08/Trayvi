import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAppConfig } from '@trayvi/config';
import { StructuredLogger } from '@trayvi/observability';

import type { ApiApplication } from '../src/bootstrap';
import { createApiApplication } from '../src/bootstrap';

describe('API request logging boundary', () => {
  let runtime: ApiApplication | undefined;

  afterEach(async () => {
    await runtime?.close();
  });

  it('correlates safe metadata without logging headers, body, or query values', async () => {
    const destination = new PassThrough();
    let output = '';
    destination.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'integration',
      level: 'info',
      format: 'json',
      destination,
    });
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'api',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      },
      'api',
    );
    runtime = await createApiApplication(config, { logger });
    const requestId = '018f4f7a-3c2b-7b11-8abc-0123456789ab';
    const correlationId = '018f4f7a-3c2b-7b11-8abc-1123456789ab';
    const sensitiveCanary = 'request-log-secret-canary';

    const response = await runtime.app.inject({
      method: 'POST',
      url: `/${'missing'}?access_token=${sensitiveCanary}`,
      headers: {
        authorization: `Bearer ${sensitiveCanary}`,
        cookie: `session=${sensitiveCanary}`,
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
      },
      payload: { password: sensitiveCanary },
    });
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(404);
    expect(output).toContain('http.request.completed');
    expect(output).toContain(requestId);
    expect(output).toContain(correlationId);
    expect(output).not.toContain(sensitiveCanary);
    expect(output).not.toContain('access_token');
    expect(output).not.toContain('authorization');
    expect(output).not.toContain('password');
  });

  it('keeps the correct explicit context on concurrent timeout failure and completion logs', async () => {
    const destination = new PassThrough();
    let output = '';
    destination.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'integration',
      level: 'info',
      format: 'json',
      destination,
    });
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'api',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        HTTP_REQUEST_TIMEOUT_MS: '100',
      },
      'api',
    );
    runtime = await createApiApplication(config, {
      logger,
      configureServer(server) {
        server.get('/test-only/correlated-timeout', async (request) => {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { aborted: true };
        });
      },
    });
    const activeRuntime = runtime;
    const expected = Array.from({ length: 25 }, (_, index) => ({
      requestId: `018f4f7a-3c2b-7b11-8abc-${index.toString().padStart(12, '0')}`,
      correlationId: `018f4f7a-3c2b-7b11-9abc-${index.toString().padStart(12, '0')}`,
    }));

    const responses = await Promise.all(
      expected.map((context) =>
        activeRuntime.app.inject({
          method: 'GET',
          url: '/test-only/correlated-timeout',
          headers: {
            'x-request-id': context.requestId,
            'x-correlation-id': context.correlationId,
          },
        }),
      ),
    );
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(responses.every((response) => response.statusCode === 503)).toBe(true);
    expect(
      responses.map((response) => ({
        requestId: response.headers['x-request-id'],
        correlationId: response.headers['x-correlation-id'],
      })),
    ).toEqual(expected);
    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const event of ['http.request.failed', 'http.request.completed']) {
      const eventRecords = records.filter((record) => record.event === event);
      expect(eventRecords).toHaveLength(expected.length);
      expect(
        eventRecords.map((record) => `${record.requestId}:${record.correlationId}`).sort(),
      ).toEqual(
        expected.map(({ requestId, correlationId }) => `${requestId}:${correlationId}`).sort(),
      );
    }
  });
});
