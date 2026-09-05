import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import type { FoundationMetrics, Logger } from '@trayvi/observability';

import { WORKER_LOGGER, WORKER_METRICS } from './tokens';
import { WorkerLifecycle } from './worker-lifecycle';

export interface WorkerModuleDependencies {
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
}

@Module({})
export class WorkerModule {
  static register(dependencies: WorkerModuleDependencies): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WORKER_LOGGER, useValue: dependencies.logger },
        { provide: WORKER_METRICS, useValue: dependencies.metrics },
        WorkerLifecycle,
      ],
    };
  }
}
