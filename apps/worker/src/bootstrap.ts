import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

import type { AppConfig } from '@trayvi/config';
import { FoundationMetrics, initializeTelemetry, StructuredLogger } from '@trayvi/observability';
import type { Logger, TelemetryHandle } from '@trayvi/observability';

import { NestLoggerAdapter } from './nest-logger.adapter';
import { WorkerModule } from './worker.module';

export interface WorkerApplication {
  readonly app: INestApplicationContext;
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
  readonly telemetry: TelemetryHandle;
  close(signal?: string): Promise<void>;
}

export async function createWorkerApplication(config: AppConfig): Promise<WorkerApplication> {
  const logger = new StructuredLogger({
    service: config.service.name,
    environment: config.environment,
    version: config.service.version,
    level: config.logging.level,
    format: config.logging.format,
  });
  const metrics = new FoundationMetrics(config.metrics.enabled);
  const telemetry = initializeTelemetry(
    {
      enabled: config.telemetry.enabled,
      ...(config.telemetry.exporterEndpoint ? { endpoint: config.telemetry.exporterEndpoint } : {}),
      timeoutMs: config.telemetry.exporterTimeoutMs,
      service: config.service.name,
      version: config.service.version,
      environment: config.environment,
    },
    logger,
  );
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({ logger, metrics }),
    { abortOnError: true, bufferLogs: false, logger: false },
  );
  app.useLogger(new NestLoggerAdapter(logger));

  let closePromise: Promise<void> | undefined;
  return {
    app,
    logger,
    metrics,
    telemetry,
    close(signal = 'APPLICATION_CLOSE'): Promise<void> {
      closePromise ??= (async () => {
        metrics.recordWorkerLifecycle('draining');
        logger.info('worker.draining', { signal, outcome: 'started' });
        await app.close();
        await telemetry.shutdown();
        logger.flush();
      })();
      return closePromise;
    },
  };
}
