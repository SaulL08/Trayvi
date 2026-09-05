import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { AppConfig } from '@trayvi/config';
import type { FoundationMetrics, Logger } from '@trayvi/observability';

import { APP_CONFIG, APP_LOGGER, FOUNDATION_METRICS } from './tokens';

export interface DatabaseReadinessResult {
  readonly status: 'up' | 'down' | 'timeout';
  readonly durationMilliseconds: number;
}

@Injectable()
export class DatabaseProbe implements OnModuleDestroy {
  readonly #pool: Pool;
  readonly #database: Kysely<Record<never, never>>;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #metrics: FoundationMetrics;
  #closed = false;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(APP_LOGGER) logger: Logger,
    @Inject(FOUNDATION_METRICS) metrics: FoundationMetrics,
  ) {
    this.#timeoutMs = config.database.readinessTimeoutMs;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#pool = new Pool({
      connectionString: config.database.url,
      connectionTimeoutMillis: this.#timeoutMs,
      idleTimeoutMillis: 30_000,
      max: 5,
      options: config.database.runtimeRole ? `-c role=${config.database.runtimeRole}` : undefined,
      query_timeout: this.#timeoutMs,
      statement_timeout: this.#timeoutMs,
    });
    this.#pool.on('error', (error) => {
      this.#logger.error('database.pool.error', error, { outcome: 'failed' });
    });
    this.#database = new Kysely<Record<never, never>>({
      dialect: new PostgresDialect({ pool: this.#pool }),
    });
  }

  async check(): Promise<DatabaseReadinessResult> {
    const started = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), this.#timeoutMs);
      timeout.unref();
    });
    const queryResult = sql<{
      readonly ready: number;
      readonly postgisVersion: string;
    }>`SELECT 1 AS ready, PostGIS_Lib_Version() AS postgis_version`
      .execute(this.#database)
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    const status = await Promise.race([queryResult, timeoutResult]);
    if (timeout) clearTimeout(timeout);
    const durationMilliseconds = Math.round((performance.now() - started) * 100) / 100;
    this.#metrics.recordDatabaseProbe(status, durationMilliseconds);
    if (status !== 'up') {
      this.#logger.warn('database.readiness.failed', { status, durationMilliseconds });
    }
    return { status, durationMilliseconds };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#database.destroy();
  }
}
