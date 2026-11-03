import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '@trayvi/config';

import { createApiApplication } from '../src/bootstrap';

function config(trustedProxyHops: string) {
  return parseAppConfig(
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'api',
      SERVICE_VERSION: 'integration',
      // No database is needed: these routes never touch it.
      DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
      HTTP_TRUSTED_PROXY_HOPS: trustedProxyHops,
    },
    'api',
  );
}

async function withProbe<T>(
  trustedProxyHops: string,
  run: (inject: Awaited<ReturnType<typeof createApiApplication>>['app']['inject']) => Promise<T>,
): Promise<T> {
  const runtime = await createApiApplication(config(trustedProxyHops), {
    configureServer(server) {
      server.post('/test-only/ingress', (request: FastifyRequest & { rawBody?: Buffer }) => ({
        ip: request.ip,
        raw: request.rawBody?.toString('base64') ?? null,
      }));
    },
  });
  try {
    return await run(runtime.app.inject.bind(runtime.app));
  } finally {
    await runtime.close();
  }
}

describe('HTTP ingress settings for SPEC-001', () => {
  it('ignores X-Forwarded-For unless proxies are explicitly trusted', async () => {
    const forwarded = {
      'x-forwarded-for': '198.51.100.7, 203.0.113.9',
      'content-type': 'application/json',
    };
    await withProbe('0', async (inject) => {
      const response = await inject({
        method: 'POST',
        url: '/test-only/ingress',
        headers: forwarded,
        payload: '{}',
        remoteAddress: '192.0.2.1',
      });
      expect(response.json()).toMatchObject({ ip: '192.0.2.1' });
    });
    await withProbe('1', async (inject) => {
      const response = await inject({
        method: 'POST',
        url: '/test-only/ingress',
        headers: forwarded,
        payload: '{}',
        remoteAddress: '192.0.2.1',
      });
      expect(response.json()).toMatchObject({ ip: '203.0.113.9' });
    });
    await withProbe('2', async (inject) => {
      const response = await inject({
        method: 'POST',
        url: '/test-only/ingress',
        headers: forwarded,
        payload: '{}',
        remoteAddress: '192.0.2.1',
      });
      expect(response.json()).toMatchObject({ ip: '198.51.100.7' });
    });
  });

  it('keeps the exact raw JSON body for signature verification', async () => {
    const payload = '{"providerEventId":"evt-1",  "status":"DELIVERED"}\n';
    await withProbe('0', async (inject) => {
      const response = await inject({
        method: 'POST',
        url: '/test-only/ingress',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(Buffer.from((response.json() as { raw: string }).raw, 'base64').toString('utf8')).toBe(
        payload,
      );
    });
  });
});
