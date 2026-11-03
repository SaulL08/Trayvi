import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';

import type { AppConfig, AuthConfig } from '@trayvi/config';
import type { FoundationMetrics, Logger } from '@trayvi/observability';

import { composeAuthServices, type AuthServices } from './auth-composition';
import { AuthExceptionFilter } from './auth-problem';
import { registerCallbackRoutes } from './callback-routes';
import { ChallengeController } from './challenge.controller';
import { AUTH_LOGGER, AUTH_SERVICES } from './tokens';

export interface AuthHttpDependencies {
  readonly config: AppConfig;
  readonly auth: AuthConfig;
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
}

@Injectable()
class AuthHttpLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(AUTH_SERVICES) private readonly services: AuthServices,
    @Inject(AUTH_LOGGER) private readonly logger: Logger,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  onModuleInit(): void {
    registerCallbackRoutes(
      this.adapterHost.httpAdapter.getInstance<FastifyInstance>(),
      this.services,
      this.logger,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.services.close();
  }
}

/** SPEC-001 composition root for Auth HTTP routes (ws-e). */
@Module({})
export class AuthHttpModule {
  static register(dependencies: AuthHttpDependencies): DynamicModule {
    return {
      module: AuthHttpModule,
      controllers: [ChallengeController],
      providers: [
        { provide: AUTH_LOGGER, useValue: dependencies.logger },
        {
          provide: AUTH_SERVICES,
          useFactory: () => composeAuthServices(dependencies.config, dependencies.auth),
        },
        AuthExceptionFilter,
        AuthHttpLifecycle,
      ],
      exports: [AUTH_SERVICES],
    };
  }
}
