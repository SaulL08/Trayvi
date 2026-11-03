import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import type { AppConfig, AuthConfig } from '@trayvi/config';
import type { FoundationMetrics, Logger } from '@trayvi/observability';

export interface AuthHttpDependencies {
  readonly config: AppConfig;
  readonly auth: AuthConfig;
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
}

/**
 * SPEC-001 composition root for Auth HTTP routes. The integration scaffold registers it empty;
 * ws-e owns this directory and composes the real implementations here.
 */
@Module({})
export class AuthHttpModule {
  static register(_dependencies: AuthHttpDependencies): DynamicModule {
    return { module: AuthHttpModule };
  }
}
