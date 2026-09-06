import { createServer } from 'node:net';

import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '@trayvi/config';
import type { Logger } from '@trayvi/observability';

import { IncompleteShutdownError } from '../src/active-operations';
import type { ApiApplication } from '../src/bootstrap';
import { createApiApplication } from '../src/bootstrap';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function testConfig(shutdownTimeoutMs: number) {
  return parseAppConfig(
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'api',
      SERVICE_VERSION: 'shutdown-test',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      HTTP_REQUEST_TIMEOUT_MS: '100',
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    },
    'api',
  );
}

function recordingLogger(): Logger & { readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    debug: vi.fn((event: string) => events.push(event)),
    info: vi.fn((event: string) => events.push(event)),
    warn: vi.fn((event: string) => events.push(event)),
    error: vi.fn((event: string) => events.push(event)),
    flush: vi.fn(),
  };
}

describe('API active-operation shutdown', () => {
  let runtime: ApiApplication | undefined;

  afterEach(async () => {
    if (runtime?.runtime.lifecycle !== 'FAILED') await runtime?.close();
    runtime = undefined;
  });

  it('drains normal active work before logging a successful stop and deduplicates close', async () => {
    const logger = recordingLogger();
    let started: (() => void) | undefined;
    let release: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => (started = resolve));
    const handlerRelease = new Promise<void>((resolve) => (release = resolve));
    runtime = await createApiApplication(testConfig(1_000), {
      logger,
      configureServer(server) {
        server.get('/test-only/drain', async () => {
          started?.();
          await handlerRelease;
          return { completed: true };
        });
      },
    });
    const port = await availablePort();
    await runtime.app.listen({ host: '127.0.0.1', port });
    const response = fetch(`http://127.0.0.1:${port}/test-only/drain`);
    await handlerStarted;

    const firstClose = runtime.close('SIGTERM');
    const secondClose = runtime.close('SIGINT');
    expect(firstClose).toBe(secondClose);
    expect(runtime.runtime.acceptsTraffic()).toBe(false);
    expect(logger.events).not.toContain('api.stopped');

    release?.();
    expect((await response).status).toBe(200);
    await firstClose;
    expect(logger.events.indexOf('api.draining')).toBeLessThan(
      logger.events.indexOf('api.stopped'),
    );
    expect(runtime.runtime.lifecycle).toBe('STOPPED');
  });

  it('exposes Fastify abort to cancelable timed-out work', async () => {
    let aborted: (() => void) | undefined;
    const handlerAborted = new Promise<void>((resolve) => (aborted = resolve));
    runtime = await createApiApplication(testConfig(1_000), {
      configureServer(server) {
        server.get('/test-only/cancelable', async (request: FastifyRequest) => {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              'abort',
              () => {
                aborted?.();
                resolve();
              },
              { once: true },
            );
          });
          return { aborted: true };
        });
      },
    });
    const response = await runtime.app.inject({ method: 'GET', url: '/test-only/cancelable' });

    expect(response.statusCode).toBe(503);
    await handlerAborted;
    await expect(runtime.close('SIGTERM')).resolves.toBeUndefined();
  });

  it('reports incomplete shutdown and never logs api.stopped when non-cancelable work exceeds the deadline', async () => {
    const logger = recordingLogger();
    let release: (() => void) | undefined;
    const handlerRelease = new Promise<void>((resolve) => (release = resolve));
    runtime = await createApiApplication(testConfig(500), {
      logger,
      configureServer(server) {
        server.get('/test-only/non-cancelable', async () => {
          await handlerRelease;
          return { tooLate: true };
        });
      },
    });
    const response = await runtime.app.inject({ method: 'GET', url: '/test-only/non-cancelable' });
    expect(response.statusCode).toBe(503);

    const close = runtime.close('SIGTERM');
    await expect(close).rejects.toBeInstanceOf(IncompleteShutdownError);
    expect(runtime.runtime.lifecycle).toBe('FAILED');
    expect(logger.events).toContain('api.shutdown.incomplete');
    expect(logger.events).not.toContain('api.stopped');

    release?.();
  });
});
