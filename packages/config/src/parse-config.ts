import { z } from 'zod';

import { ConfigValidationError } from './config-error';
import type { AppConfig, MigrationConfig, RawEnvironment, ServiceName } from './types';

const numberField = (defaultValue: number, minimum: number, maximum: number) =>
  z.preprocess(
    (value) => (value === '' || value === undefined ? defaultValue : value),
    z.coerce.number().int().min(minimum).max(maximum),
  );

const booleanField = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (value === '' || value === undefined ? String(defaultValue) : value),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  );

const optionalTextField = (maximum: number) =>
  z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.string().trim().max(maximum).optional(),
  );

const rawSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    SERVICE_NAME: z.enum(['api', 'worker']),
    SERVICE_VERSION: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/u),
    HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
    PORT: numberField(3000, 1, 65_535),
    DATABASE_URL: z.string().trim().min(1).max(2_048),
    DATABASE_RUNTIME_ROLE: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .optional(),
    DATABASE_READY_TIMEOUT_MS: numberField(1_000, 50, 10_000),
    CORS_ALLOWED_ORIGINS: z.string().default(''),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
    OTEL_ENABLED: booleanField(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalTextField(2_048),
    OTEL_EXPORTER_TIMEOUT_MS: numberField(2_000, 100, 10_000),
    METRICS_ENABLED: booleanField(true),
    HTTP_BODY_LIMIT_BYTES: numberField(1_048_576, 1_024, 5_242_880),
    HTTP_MAX_URL_LENGTH: numberField(2_048, 256, 8_192),
    HTTP_MAX_HEADER_SIZE_BYTES: numberField(16_384, 4_096, 32_768),
    HTTP_REQUEST_TIMEOUT_MS: numberField(15_000, 100, 120_000),
    HTTP_CONNECTION_TIMEOUT_MS: numberField(10_000, 100, 120_000),
    HTTP_KEEP_ALIVE_TIMEOUT_MS: numberField(5_000, 100, 120_000),
    SHUTDOWN_TIMEOUT_MS: numberField(10_000, 500, 60_000),
  })
  .superRefine((value, context) => {
    let databaseUrl: URL | undefined;
    try {
      databaseUrl = new URL(value.DATABASE_URL);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must be a valid PostgreSQL URL',
      });
    }

    if (databaseUrl && !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must use the PostgreSQL protocol',
      });
    }

    const origins = parseOrigins(value.CORS_ALLOWED_ORIGINS);
    for (const origin of origins) {
      if (origin === '*') {
        context.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'wildcard origins are prohibited',
        });
        continue;
      }
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
          throw new Error('invalid origin');
        }
        if (value.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
          context.addIssue({
            code: 'custom',
            path: ['CORS_ALLOWED_ORIGINS'],
            message: 'production origins must use HTTPS',
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'must contain comma-separated URL origins',
        });
      }
    }

    if (value.NODE_ENV === 'production') {
      if (origins.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'must contain at least one explicit production origin',
        });
      }
      if (databaseUrl && isUnsafeProductionDatabaseUrl(databaseUrl)) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'contains an example, missing, or unsafe production credential',
        });
      }
      if (value.HOST === '127.0.0.1' || value.HOST === 'localhost') {
        context.addIssue({
          code: 'custom',
          path: ['HOST'],
          message: 'must be explicitly configured for production binding',
        });
      }
    }

    if (value.OTEL_ENABLED && !value.OTEL_EXPORTER_OTLP_ENDPOINT) {
      context.addIssue({
        code: 'custom',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
        message: 'is required when telemetry export is enabled',
      });
    }

    if (value.OTEL_EXPORTER_OTLP_ENDPOINT) {
      try {
        const endpoint = new URL(value.OTEL_EXPORTER_OTLP_ENDPOINT);
        if (!['http:', 'https:'].includes(endpoint.protocol)) {
          throw new Error('invalid telemetry protocol');
        }
        if (value.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
          context.addIssue({
            code: 'custom',
            path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
            message: 'must use HTTPS in production',
          });
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
          message: 'must be a valid HTTP(S) URL',
        });
      }
    }
  });

function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function isUnsafeProductionDatabaseUrl(url: URL): boolean {
  const combined = `${url.username}:${url.password}`.toLowerCase();
  return (
    url.username.length === 0 ||
    url.password.length < 12 ||
    /(?:change[-_]?me|example|password|secret|placeholder|trayvi_local)/u.test(combined)
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseAppConfig(
  environment: RawEnvironment,
  expectedServiceName: ServiceName,
): AppConfig {
  const result = rawSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'environment',
        constraint: issue.message,
      })),
    );
  }

  if (result.data.SERVICE_NAME !== expectedServiceName) {
    throw new ConfigValidationError([
      { field: 'SERVICE_NAME', constraint: `must identify the ${expectedServiceName} process` },
    ]);
  }

  const endpoint = result.data.OTEL_EXPORTER_OTLP_ENDPOINT;
  const runtimeRole = result.data.DATABASE_RUNTIME_ROLE;
  const config: AppConfig = {
    environment: result.data.NODE_ENV,
    service: {
      name: result.data.SERVICE_NAME,
      version: result.data.SERVICE_VERSION,
    },
    http: {
      host: result.data.HOST,
      port: result.data.PORT,
      bodyLimitBytes: result.data.HTTP_BODY_LIMIT_BYTES,
      maxUrlLength: result.data.HTTP_MAX_URL_LENGTH,
      maxHeaderSizeBytes: result.data.HTTP_MAX_HEADER_SIZE_BYTES,
      requestTimeoutMs: result.data.HTTP_REQUEST_TIMEOUT_MS,
      connectionTimeoutMs: result.data.HTTP_CONNECTION_TIMEOUT_MS,
      keepAliveTimeoutMs: result.data.HTTP_KEEP_ALIVE_TIMEOUT_MS,
      shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
    },
    database: {
      url: result.data.DATABASE_URL,
      readinessTimeoutMs: result.data.DATABASE_READY_TIMEOUT_MS,
      ...(runtimeRole ? { runtimeRole } : {}),
    },
    cors: {
      allowedOrigins: parseOrigins(result.data.CORS_ALLOWED_ORIGINS),
      credentials: false,
    },
    logging: {
      level: result.data.LOG_LEVEL,
      format: result.data.LOG_FORMAT,
    },
    telemetry: {
      enabled: result.data.OTEL_ENABLED,
      ...(endpoint ? { exporterEndpoint: endpoint } : {}),
      exporterTimeoutMs: result.data.OTEL_EXPORTER_TIMEOUT_MS,
    },
    metrics: {
      enabled: result.data.METRICS_ENABLED,
    },
  };

  return deepFreeze(config) as AppConfig;
}

export function parseMigrationConfig(environment: RawEnvironment): MigrationConfig {
  const candidate = environment.MIGRATION_DATABASE_URL ?? environment.DATABASE_URL;
  const result = z.string().trim().min(1).max(2_048).safeParse(candidate);
  if (!result.success) {
    throw new ConfigValidationError([
      { field: 'MIGRATION_DATABASE_URL', constraint: 'must be a valid PostgreSQL URL' },
    ]);
  }
  try {
    const url = new URL(result.data);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid protocol');
  } catch {
    throw new ConfigValidationError([
      { field: 'MIGRATION_DATABASE_URL', constraint: 'must be a valid PostgreSQL URL' },
    ]);
  }
  return deepFreeze({ databaseUrl: result.data });
}
