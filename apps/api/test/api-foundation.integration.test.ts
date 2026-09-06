import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMigrationConfig, parseAppConfig } from '@trayvi/config';
import {
  createDisposableDatabase,
  createNamedDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  executeSqlFile,
} from '@trayvi/test-support';

import { createApiApplication } from '../src/bootstrap';
import { SqlMigrator } from '../../../scripts/db/migrate.js';

describe('API foundation with real PostgreSQL/PostGIS', () => {
  it('separates liveness/readiness and recovers readiness after database restoration', async () => {
    const adminUrl = loadMigrationConfig().databaseUrl;
    const bootstrapSql = await readFile(resolve('infra/database/bootstrap/0001_roles.sql'), 'utf8');
    await executeSqlFile(adminUrl, bootstrapSql);
    const database = await createDisposableDatabase(adminUrl, 'trayvi_api');
    let databaseExists = true;
    let migrator = new SqlMigrator(database.url);
    await migrator.up();
    await migrator.close();
    const runtimeLogin = await createRestrictedRuntimeLogin(adminUrl, database.url);
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'api',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: runtimeLogin.url,
        CORS_ALLOWED_ORIGINS: 'https://allowed.example',
        HTTP_BODY_LIMIT_BYTES: '1024',
        HTTP_MAX_URL_LENGTH: '256',
        HTTP_MAX_HEADER_SIZE_BYTES: '4096',
      },
      'api',
    );
    const runtime = await createApiApplication(config);

    try {
      const live = await runtime.app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'ok' });

      const ready = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'up' } });

      await dropDisposableDatabase(adminUrl, database.name);
      databaseExists = false;
      const unavailable = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'down' },
      });
      expect(unavailable.body).not.toContain('127.0.0.1');

      await createNamedDisposableDatabase(adminUrl, database.name);
      databaseExists = true;
      migrator = new SqlMigrator(database.url);
      await migrator.up();
      await migrator.close();
      const recovered = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
      expect(recovered.statusCode).toBe(200);

      const requestId = '018f4f7a-3c2b-7b11-8abc-0123456789ab';
      const correlationId = '018f4f7a-3c2b-7b11-8abc-1123456789ab';
      const correlated = await runtime.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': requestId, 'x-correlation-id': correlationId },
      });
      expect(correlated.headers['x-request-id']).toBe(requestId);
      expect(correlated.headers['x-correlation-id']).toBe(correlationId);

      const replaced = await runtime.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'malformed', 'x-correlation-id': 'x'.repeat(1_000) },
      });
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
      expect(replaced.headers['x-request-id']).not.toBe('malformed');
      expect(replaced.headers['x-correlation-id']).not.toBe('x'.repeat(1_000));

      const allowedCors = await runtime.app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: { origin: 'https://allowed.example', 'access-control-request-method': 'GET' },
      });
      expect(allowedCors.headers['access-control-allow-origin']).toBe('https://allowed.example');
      expect(allowedCors.headers['access-control-allow-credentials']).toBeUndefined();
      expect(allowedCors.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
      expect(allowedCors.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/u);

      const deniedCors = await runtime.app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: { origin: 'https://denied.example', 'access-control-request-method': 'GET' },
      });
      expect(deniedCors.headers['access-control-allow-origin']).toBeUndefined();
      expect(deniedCors.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);

      const longUrl = await runtime.app.inject({
        method: 'GET',
        url: `/health/live?value=${'a'.repeat(300)}`,
      });
      expect(longUrl.statusCode).toBe(414);
      expect(longUrl.json()).toMatchObject({ code: 'REQUEST_URI_TOO_LONG' });

      const largeHeader = await runtime.app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-padding': 'a'.repeat(5_000) },
      });
      expect(largeHeader.statusCode).toBe(431);

      const oversized = await runtime.app.inject({
        method: 'POST',
        url: '/health/live',
        headers: { 'content-type': 'application/json' },
        payload: { value: 'a'.repeat(2_000) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

      expect(runtime.metrics.snapshot().httpRequests).not.toEqual({});
    } finally {
      await runtime.close();
      await dropRestrictedRuntimeLogin(adminUrl, runtimeLogin.name);
      if (databaseExists) await dropDisposableDatabase(adminUrl, database.name);
    }
  });

  it('keeps liveness independent when its configured database is unreachable', async () => {
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'api',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
        DATABASE_READY_TIMEOUT_MS: '100',
      },
      'api',
    );
    const runtime = await createApiApplication(config);
    try {
      const live = await runtime.app.inject({ method: 'GET', url: '/health/live' });
      const ready = await runtime.app.inject({ method: 'GET', url: '/health/ready' });
      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(ready.body).not.toContain('ECONNREFUSED');
    } finally {
      await runtime.close();
    }
  });

  it('bounds slow handlers and returns a safe timeout response', async () => {
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'api',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
        HTTP_REQUEST_TIMEOUT_MS: '100',
      },
      'api',
    );
    const runtime = await createApiApplication(config, {
      configureServer(server) {
        server.get('/test-only/slow-handler', async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { tooLate: true };
        });
      },
    });

    try {
      const startedAt = performance.now();
      const response = await runtime.app.inject({ method: 'GET', url: '/test-only/slow-handler' });
      const durationMilliseconds = performance.now() - startedAt;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
      expect(response.body).not.toContain('FST_ERR_HANDLER_TIMEOUT');
      expect(response.body).not.toContain('slow-handler');
      expect(durationMilliseconds).toBeLessThan(400);
    } finally {
      await runtime.close();
    }
  });
});
