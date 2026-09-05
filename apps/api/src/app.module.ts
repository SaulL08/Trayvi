import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import type { AppConfig } from '@trayvi/config';
import type { FoundationMetrics, Logger } from '@trayvi/observability';

import { DatabaseProbe } from './database-probe';
import { HealthController } from './health/health.controller';
import type { RuntimeState } from './runtime-state';
import {
  APP_CONFIG,
  APP_DATABASE_PROBE,
  APP_LOGGER,
  FOUNDATION_METRICS,
  RUNTIME_STATE,
} from './tokens';

export interface AppModuleDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
  readonly runtime: RuntimeState;
}

@Module({})
export class AppModule {
  static register(dependencies: AppModuleDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: dependencies.config },
        { provide: APP_LOGGER, useValue: dependencies.logger },
        { provide: FOUNDATION_METRICS, useValue: dependencies.metrics },
        { provide: RUNTIME_STATE, useValue: dependencies.runtime },
        { provide: APP_DATABASE_PROBE, useClass: DatabaseProbe },
      ],
    };
  }
}
