import { parseAppConfig, parseMigrationConfig } from './parse-config';
import type { AppConfig, MigrationConfig, ServiceName } from './types';

export function loadAppConfig(expectedServiceName: ServiceName): AppConfig {
  return parseAppConfig(process.env, expectedServiceName);
}

export function loadMigrationConfig(): MigrationConfig {
  return parseMigrationConfig(process.env);
}
