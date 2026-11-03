import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';

import {
  loadMigrationConfig,
  parseAppConfig,
  parseAuthConfig,
  type RawEnvironment,
} from '@trayvi/config';
import type { Logger } from '@trayvi/observability';
import { createOpaqueId } from '@trayvi/observability';
import {
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '@trayvi/test-support';

import { SqlMigrator } from '../../../../scripts/db/migrate';
import type { AuthServices } from '../../src/auth/auth-composition';
import { AUTH_SERVICES } from '../../src/auth/tokens';
import { createApiApplication, type ApiApplication } from '../../src/bootstrap';

export const callbackSecret = Buffer.alloc(32, 0x5c);

export interface AuthHarness {
  readonly runtime: ApiApplication;
  readonly services: AuthServices;
  /** Superuser pool for fixtures and assertions only. */
  readonly admin: Pool;
  close(): Promise<void>;
}

/** The full API over a disposable database, running as a restricted trayvi_runtime login. */
export async function createAuthHarness(
  authEnvironment: RawEnvironment = {},
  logger?: Logger,
): Promise<AuthHarness> {
  const adminUrl = loadMigrationConfig().databaseUrl;
  await ensureDatabaseBootstrap(adminUrl);
  const database = await createDisposableDatabase(adminUrl, 'trayvi_api_auth');
  const migrator = new SqlMigrator(database.url);
  await migrator.up();
  await migrator.close();
  const login = await createRestrictedRuntimeLogin(adminUrl, database.url);
  const config = parseAppConfig(
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'api',
      SERVICE_VERSION: 'integration',
      DATABASE_URL: login.url,
    },
    'api',
  );
  const auth = parseAuthConfig(
    {
      AUTH_CALLBACK_PROVIDERS: 'synthetic',
      AUTH_CALLBACK_SECRET_SYNTHETIC: callbackSecret.toString('hex'),
      ...authEnvironment,
    },
    'test',
  );
  const runtime = await createApiApplication(config, { auth, ...(logger ? { logger } : {}) });
  const services = runtime.app.get<symbol, AuthServices>(AUTH_SERVICES, { strict: false });
  const admin = new Pool({ connectionString: database.url, max: 4 });
  return {
    runtime,
    services,
    admin,
    async close() {
      await admin.end();
      await runtime.close();
      await dropRestrictedRuntimeLogin(adminUrl, login.name);
      await delay(50);
      await dropDisposableDatabase(adminUrl, database.name);
    },
  };
}

export function sign(timestamp: string, body: Buffer, secret: Buffer = callbackSecret): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

export function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1_000));
}

export function deliveredCode(services: AuthServices, challengeId: string): string {
  const message = [...services.transport.messages()]
    .reverse()
    .find((entry) => entry.request.reference === challengeId);
  if (!message?.request.code) throw new Error('no code delivered');
  return message.request.code;
}

export const installation = (): string => createOpaqueId();

let sequence = 0;
/** Distinct numbers in the fictional 555-01XX block plus a run-unique suffix range. */
export function phone(): string {
  sequence += 1;
  return `+1809${String(5_000_000 + (((Date.now() % 1_000) * 1_000 + sequence) % 5_000_000)).padStart(7, '0')}`;
}
