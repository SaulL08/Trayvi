import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import type { FoundationMetrics, Logger } from '@trayvi/observability';

import { WORKER_LOGGER, WORKER_METRICS } from './tokens';

@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(WORKER_LOGGER) private readonly logger: Logger,
    @Inject(WORKER_METRICS) private readonly metrics: FoundationMetrics,
  ) {}

  onApplicationBootstrap(): void {
    this.metrics.recordWorkerLifecycle('started');
    this.logger.info('worker.started', {
      mode: 'foundation',
      outboxProcessing: 'not_enabled',
      outcome: 'ready',
    });
  }

  onApplicationShutdown(signal?: string): void {
    this.metrics.recordWorkerLifecycle('stopped');
    this.logger.info('worker.stopped', {
      signal: signal ?? 'APPLICATION_CLOSE',
      outcome: 'success',
    });
  }
}
