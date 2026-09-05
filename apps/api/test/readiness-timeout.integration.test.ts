import { createServer } from 'node:net';
import type { Socket } from 'node:net';

import { expect, it } from 'vitest';

import { parseAppConfig } from '@trayvi/config';

import { createApiApplication } from '../src/bootstrap';

it('bounds readiness when a TCP peer accepts connections but never speaks PostgreSQL', async () => {
  const sockets = new Set<Socket>();
  const peer = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('error', reject);
    peer.listen(0, '127.0.0.1', resolve);
  });
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('No local TCP address.');
  const config = parseAppConfig(
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'api',
      SERVICE_VERSION: 'timeout-test',
      DATABASE_URL: `postgresql://unused:unused@127.0.0.1:${address.port}/unused`,
      DATABASE_READY_TIMEOUT_MS: '100',
    },
    'api',
  );
  const runtime = await createApiApplication(config);
  try {
    const started = performance.now();
    const response = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
    const elapsed = performance.now() - started;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { database: 'down' } });
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1_000);
    expect(response.body).not.toContain('127.0.0.1');
    expect((await runtime.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
