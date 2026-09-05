import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

import type { Logger } from './logger';

export interface TelemetryOptions {
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly timeoutMs: number;
  readonly service: string;
  readonly version: string;
  readonly environment: string;
}

export interface TelemetryProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryHandle {
  readonly tracer: ReturnType<typeof trace.getTracer>;
  shutdown(): Promise<void>;
}

async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<'ok' | 'failed' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    timeout.unref();
  });
  const operationPromise = operation.then(
    () => 'ok' as const,
    () => 'failed' as const,
  );
  const outcome = await Promise.race([operationPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return outcome;
}

export async function shutdownTelemetrySafely(
  provider: TelemetryProvider,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  const flushOutcome = await settleWithin(provider.forceFlush(), timeoutMs);
  if (flushOutcome !== 'ok') {
    logger.warn('telemetry.flush.failed', { outcome: flushOutcome });
  }
  const shutdownOutcome = await settleWithin(provider.shutdown(), timeoutMs);
  if (shutdownOutcome !== 'ok') {
    logger.warn('telemetry.shutdown.failed', { outcome: shutdownOutcome });
  }
}

export function initializeTelemetry(options: TelemetryOptions, logger: Logger): TelemetryHandle {
  if (!options.enabled || !options.endpoint) {
    return {
      tracer: trace.getTracer(options.service, options.version),
      shutdown: async () => undefined,
    };
  }

  try {
    const exporter = new OTLPTraceExporter({
      url: options.endpoint,
      timeoutMillis: options.timeoutMs,
    });
    const processor = new BatchSpanProcessor(exporter, {
      exportTimeoutMillis: options.timeoutMs,
      maxQueueSize: 256,
      maxExportBatchSize: 64,
    });
    const provider = new NodeTracerProvider({
      forceFlushTimeoutMillis: options.timeoutMs,
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.service,
        [ATTR_SERVICE_VERSION]: options.version,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
      }),
      spanProcessors: [processor],
    });
    provider.register();
    logger.info('telemetry.initialized', { outcome: 'enabled' });

    return {
      tracer: provider.getTracer(options.service, options.version),
      shutdown: () => shutdownTelemetrySafely(provider, options.timeoutMs, logger),
    };
  } catch (error: unknown) {
    logger.error('telemetry.initialization.failed', error, { outcome: 'disabled' });
    return {
      tracer: trace.getTracer(options.service, options.version),
      shutdown: async () => undefined,
    };
  }
}
