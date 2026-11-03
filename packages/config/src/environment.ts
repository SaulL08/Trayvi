import { parseAuthConfig, type AuthConfig } from './auth-config';
import { parseAppConfig, parseMigrationConfig } from './parse-config';
import type { AppConfig, MigrationConfig, RuntimeEnvironment, ServiceName } from './types';

export function loadAppConfig(expectedServiceName: ServiceName): AppConfig {
  return parseAppConfig(process.env, expectedServiceName);
}

export function loadAuthConfig(runtime: RuntimeEnvironment): AuthConfig {
  return parseAuthConfig(process.env, runtime);
}

export function loadMigrationConfig(): MigrationConfig {
  return parseMigrationConfig(process.env);
}
