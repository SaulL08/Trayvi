import { describe, expect, it } from 'vitest';

import { ConfigValidationError, parseAppConfig, parseMigrationConfig } from '../src';
import type { RawEnvironment } from '../src';

const validEnvironment: RawEnvironment = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'api',
  SERVICE_VERSION: 'test-build',
  DATABASE_URL: 'postgresql://test_user:local-only-value@127.0.0.1:5432/trayvi_test',
};

describe('configuration composition', () => {
  it('returns a deeply immutable, typed configuration', () => {
    const config = parseAppConfig(validEnvironment, 'api');

    expect(config.http.bodyLimitBytes).toBe(1_048_576);
    expect(config.cors.credentials).toBe(false);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('maps explicit request, readiness, body, and shutdown bounds', () => {
    const config = parseAppConfig(
      {
        ...validEnvironment,
        DATABASE_READY_TIMEOUT_MS: '250',
        HTTP_BODY_LIMIT_BYTES: '2048',
        HTTP_REQUEST_TIMEOUT_MS: '750',
        SHUTDOWN_TIMEOUT_MS: '1500',
      },
      'api',
    );

    expect(config.database.readinessTimeoutMs).toBe(250);
    expect(config.http.bodyLimitBytes).toBe(2048);
    expect(config.http.requestTimeoutMs).toBe(750);
    expect(config.http.shutdownTimeoutMs).toBe(1500);
  });

  it('fails when a critical field is absent without exposing another secret value', () => {
    const marker = 'DO-NOT-PRINT-THIS-DATABASE-PASSWORD';

    expect.assertions(4);
    try {
      parseAppConfig(
        {
          ...validEnvironment,
          SERVICE_VERSION: undefined,
          DATABASE_URL: `postgresql://test_user:${marker}@127.0.0.1:5432/trayvi_test`,
        },
        'api',
      );
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain('SERVICE_VERSION');
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
    }
  });

  it('rejects a service-name mismatch', () => {
    expect(() => parseAppConfig(validEnvironment, 'worker')).toThrow(/SERVICE_NAME/u);
  });

  it.each([
    ['wildcard CORS', { CORS_ALLOWED_ORIGINS: '*' }],
    ['malformed database URL', { DATABASE_URL: 'not-a-url' }],
    ['unsafe body limit', { HTTP_BODY_LIMIT_BYTES: '999999999' }],
    ['unsupported boolean', { OTEL_ENABLED: 'yes' }],
  ])('rejects %s', (_name, override) => {
    expect(() => parseAppConfig({ ...validEnvironment, ...override }, 'api')).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects production placeholder credentials, insecure origins, and implicit bind host', () => {
    expect(() =>
      parseAppConfig(
        {
          ...validEnvironment,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://example:password@db.invalid/trayvi',
          CORS_ALLOWED_ORIGINS: 'http://admin.example.com',
        },
        'api',
      ),
    ).toThrow(ConfigValidationError);
  });

  it('requires a telemetry endpoint when export is enabled', () => {
    expect(() => parseAppConfig({ ...validEnvironment, OTEL_ENABLED: 'true' }, 'api')).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/u,
    );
  });

  it('treats a blank optional telemetry endpoint as disabled', () => {
    const config = parseAppConfig(
      { ...validEnvironment, OTEL_ENABLED: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: '' },
      'api',
    );

    expect(config.telemetry.exporterEndpoint).toBeUndefined();
  });

  it.each(['staging', 'production'] as const)(
    'requires verified database TLS in %s',
    (environment) => {
      expect(() =>
        parseAppConfig(
          {
            ...validEnvironment,
            NODE_ENV: environment,
            HOST: '0.0.0.0',
            DATABASE_URL: 'postgresql://remote_user:long-random-value@db.example/trayvi',
            CORS_ALLOWED_ORIGINS: 'https://admin.example.com',
          },
          'api',
        ),
      ).toThrow(/DATABASE_TLS_MODE/u);
    },
  );

  it('maps verify-full TLS with certificate validation for applications and migrations', () => {
    const environment = {
      ...validEnvironment,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://remote_user:long-random-value@db.example/trayvi',
      MIGRATION_DATABASE_URL: 'postgresql://migration_user:long-random-value@db.example/trayvi',
      DATABASE_TLS_MODE: 'verify-full',
      DATABASE_TLS_CA: 'trusted-ca-certificate',
      CORS_ALLOWED_ORIGINS: 'https://admin.example.com',
    } as const;

    expect(parseAppConfig(environment, 'api').database.tls).toEqual({
      mode: 'verify-full',
      rejectUnauthorized: true,
      ca: 'trusted-ca-certificate',
    });
    expect(parseMigrationConfig(environment).databaseTls).toEqual({
      mode: 'verify-full',
      rejectUnauthorized: true,
      ca: 'trusted-ca-certificate',
    });
  });

  it('rejects URL query parameters that could weaken or conflict with the typed TLS policy', () => {
    const environment = {
      ...validEnvironment,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      DATABASE_URL:
        'postgresql://remote_user:long-random-value@db.example/trayvi?sslmode=no-verify',
      DATABASE_TLS_MODE: 'verify-full',
      CORS_ALLOWED_ORIGINS: 'https://admin.example.com',
    } as const;

    expect(() => parseAppConfig(environment, 'api')).toThrow(/DATABASE_URL/u);
    expect(() => parseMigrationConfig(environment)).toThrow(/DATABASE_URL/u);
  });

  it('keeps an explicit local-development TLS exception', () => {
    const application = parseAppConfig(validEnvironment, 'api');
    const migration = parseMigrationConfig(validEnvironment);

    expect(application.database.tls).toEqual({ mode: 'disable' });
    expect(migration.databaseTls).toEqual({ mode: 'disable' });
  });

  it('fails migration configuration closed when the environment is absent or invalid', () => {
    const missingEnvironment = { ...validEnvironment, NODE_ENV: undefined };

    expect(() => parseMigrationConfig(missingEnvironment)).toThrow(/NODE_ENV/u);
    expect(() => parseMigrationConfig({ ...validEnvironment, NODE_ENV: 'preview' })).toThrow(
      /NODE_ENV/u,
    );
  });

  it.each(['staging', 'production'] as const)(
    'accepts only explicit verify-full migration TLS in %s',
    (environment) => {
      const base = {
        ...validEnvironment,
        NODE_ENV: environment,
        MIGRATION_DATABASE_URL: 'postgresql://migration_user:long-random-value@db.example/trayvi',
      } as const;

      expect(() =>
        parseMigrationConfig({ ...base, DATABASE_TLS_MODE: 'verify-full' }),
      ).not.toThrow();
      expect(() => parseMigrationConfig({ ...base, DATABASE_TLS_MODE: 'disable' })).toThrow(
        /DATABASE_TLS_MODE/u,
      );
      const missingMode = { ...base, DATABASE_TLS_MODE: undefined };
      expect(() => parseMigrationConfig(missingMode)).toThrow(/DATABASE_TLS_MODE/u);
    },
  );
});
