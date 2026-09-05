export type RuntimeEnvironment = 'development' | 'test' | 'staging' | 'production';
export type ServiceName = 'api' | 'worker';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export interface AppConfig {
  readonly environment: RuntimeEnvironment;
  readonly service: {
    readonly name: ServiceName;
    readonly version: string;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimitBytes: number;
    readonly maxUrlLength: number;
    readonly maxHeaderSizeBytes: number;
    readonly requestTimeoutMs: number;
    readonly connectionTimeoutMs: number;
    readonly keepAliveTimeoutMs: number;
    readonly shutdownTimeoutMs: number;
  };
  readonly database: {
    readonly url: string;
    readonly readinessTimeoutMs: number;
    readonly runtimeRole?: string;
  };
  readonly cors: {
    readonly allowedOrigins: readonly string[];
    readonly credentials: false;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly format: LogFormat;
  };
  readonly telemetry: {
    readonly enabled: boolean;
    readonly exporterEndpoint?: string;
    readonly exporterTimeoutMs: number;
  };
  readonly metrics: {
    readonly enabled: boolean;
  };
}

export type RawEnvironment = Readonly<Record<string, string | undefined>>;

export interface MigrationConfig {
  readonly databaseUrl: string;
}
