import {
  context as otelContext,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { HttpStatus } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyRequest, RawRequestDefaultExpression } from 'fastify';

import type { AppConfig } from '@trayvi/config';
import {
  createRequestContext,
  FoundationMetrics,
  initializeTelemetry,
  runWithRequestContext,
  StructuredLogger,
} from '@trayvi/observability';
import type { Logger, TelemetryHandle } from '@trayvi/observability';

import { AppModule } from './app.module';
import { NestLoggerAdapter } from './http/nest-logger.adapter';
import type { ProblemDetails } from './http/problem-details';
import { SafeExceptionFilter } from './http/safe-exception.filter';
import { RuntimeState } from './runtime-state';

interface RequestTiming {
  readonly startedAt: number;
  readonly span: ReturnType<TelemetryHandle['tracer']['startSpan']>;
}

const REQUEST_HEADER_FIELDS_TOO_LARGE = 431;

export interface ApiApplication {
  readonly app: NestFastifyApplication;
  readonly logger: Logger;
  readonly metrics: FoundationMetrics;
  readonly runtime: RuntimeState;
  readonly telemetry: TelemetryHandle;
  close(signal?: string): Promise<void>;
}

export interface ApiApplicationOverrides {
  readonly logger?: Logger;
  readonly configureServer?: (server: FastifyInstance) => void;
}

function fixedProblem(
  status: number,
  code: string,
  title: string,
  requestId: string,
): ProblemDetails {
  return { type: 'about:blank', title, status, code, requestId };
}

function headerSize(request: FastifyRequest): number {
  return Object.entries(request.headers).reduce((total, [name, value]) => {
    const serialized = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return total + Buffer.byteLength(name) + Buffer.byteLength(serialized) + 4;
  }, 2);
}

export async function createApiApplication(
  config: AppConfig,
  overrides: ApiApplicationOverrides = {},
): Promise<ApiApplication> {
  const logger =
    overrides.logger ??
    new StructuredLogger({
      service: config.service.name,
      environment: config.environment,
      version: config.service.version,
      level: config.logging.level,
      format: config.logging.format,
    });
  const metrics = new FoundationMetrics(config.metrics.enabled);
  const runtime = new RuntimeState();
  runtime.beginInitialization();
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

  const adapter = new FastifyAdapter({
    bodyLimit: config.http.bodyLimitBytes,
    connectionTimeout: config.http.connectionTimeoutMs,
    forceCloseConnections: 'idle',
    genReqId: (request: RawRequestDefaultExpression) =>
      createRequestContext(request.headers['x-request-id'], undefined).requestId,
    handlerTimeout: config.http.requestTimeoutMs,
    http: { maxHeaderSize: config.http.maxHeaderSizeBytes },
    keepAliveTimeout: config.http.keepAliveTimeoutMs,
    logger: false,
    requestTimeout: config.http.requestTimeoutMs,
    return503OnClosing: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ config, logger, metrics, runtime }),
    adapter,
    { abortOnError: true, bufferLogs: false, logger: false },
  );
  app.useLogger(new NestLoggerAdapter(logger));
  app.useGlobalFilters(new SafeExceptionFilter(logger));

  const server = app.getHttpAdapter().getInstance() as FastifyInstance;
  const requestTimings = new WeakMap<FastifyRequest, RequestTiming>();

  server.addHook('onRequest', (request, reply, done) => {
    const extracted = propagation.extract(otelContext.active(), request.headers);
    const span = telemetry.tracer.startSpan(
      'http.server.request',
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.request.method': request.method },
      },
      extracted,
    );
    requestTimings.set(request, { startedAt: performance.now(), span });
    const spanContext = trace.setSpan(extracted, span);
    otelContext.with(spanContext, () => {
      const requestContext = createRequestContext(request.id, request.headers['x-correlation-id']);
      runWithRequestContext(requestContext, () => {
        reply.header('x-request-id', requestContext.requestId);
        reply.header('x-correlation-id', requestContext.correlationId);

        const rawUrl = request.raw.url ?? '';
        if (rawUrl.length > config.http.maxUrlLength) {
          void reply
            .code(HttpStatus.URI_TOO_LONG)
            .type('application/problem+json')
            .send(
              fixedProblem(
                HttpStatus.URI_TOO_LONG,
                'REQUEST_URI_TOO_LONG',
                'Request URI too long',
                requestContext.requestId,
              ),
            );
          done();
          return;
        }
        if (headerSize(request) > config.http.maxHeaderSizeBytes) {
          void reply
            .code(REQUEST_HEADER_FIELDS_TOO_LARGE)
            .type('application/problem+json')
            .send(
              fixedProblem(
                REQUEST_HEADER_FIELDS_TOO_LARGE,
                'REQUEST_HEADERS_TOO_LARGE',
                'Request headers too large',
                requestContext.requestId,
              ),
            );
          done();
          return;
        }
        done();
      });
    });
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: true,
    hidePoweredBy: true,
  });
  await app.register(cors, {
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    origin: (origin, callback) => {
      callback(null, origin === undefined || config.cors.allowedOrigins.includes(origin));
    },
  });

  overrides.configureServer?.(server);

  server.addHook('onResponse', (request, reply, done) => {
    const timing = requestTimings.get(request);
    const durationMilliseconds = timing ? performance.now() - timing.startedAt : 0;
    metrics.recordHttp(request.method, reply.statusCode, durationMilliseconds);
    timing?.span.setAttribute('http.response.status_code', reply.statusCode);
    if (reply.statusCode >= 500) timing?.span.setStatus({ code: SpanStatusCode.ERROR });
    timing?.span.end();

    const route = request.routeOptions?.url ?? 'unmatched';
    if (!route.startsWith('/health') || reply.statusCode >= 400) {
      logger.info('http.request.completed', {
        method: request.method,
        route,
        statusCode: reply.statusCode,
        outcome: reply.statusCode < 400 ? 'success' : 'failure',
        durationMilliseconds: Math.round(durationMilliseconds * 100) / 100,
      });
    }
    done();
  });

  try {
    await app.init();
    runtime.markReady();
    logger.info('api.initialized', { outcome: 'ready' });
  } catch (error: unknown) {
    runtime.markFailed();
    logger.error('api.initialization.failed', error, { outcome: 'failed' });
    await telemetry.shutdown();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    app,
    logger,
    metrics,
    runtime,
    telemetry,
    close(signal = 'APPLICATION_CLOSE'): Promise<void> {
      closePromise ??= (async () => {
        runtime.beginDraining();
        logger.info('api.draining', { signal, outcome: 'started' });
        await app.close();
        await telemetry.shutdown();
        runtime.markStopped();
        logger.info('api.stopped', { outcome: 'success' });
        logger.flush();
      })();
      return closePromise;
    },
  };
}
