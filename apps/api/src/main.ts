import 'reflect-metadata';

import { ConfigValidationError, loadAppConfig } from '@trayvi/config';

import { createApiApplication } from './bootstrap';

async function main(): Promise<void> {
  let config;
  try {
    config = loadAppConfig('api');
  } catch (error: unknown) {
    const message =
      error instanceof ConfigValidationError
        ? JSON.stringify({ event: 'configuration.invalid', fields: error.issues })
        : JSON.stringify({ event: 'configuration.invalid', fields: [] });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const runtime = await createApiApplication(config);
  await runtime.app.listen({ host: config.http.host, port: config.http.port });
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => {
      runtime.logger.error(
        'api.shutdown.timeout',
        new Error('graceful shutdown deadline exceeded'),
      );
      process.exitCode = 1;
      process.exit(1);
    }, config.http.shutdownTimeoutMs);
    timeout.unref();
    void runtime.close(signal).finally(() => clearTimeout(timeout));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  runtime.logger.info('api.started', {
    host: config.http.host,
    port: config.http.port,
    outcome: 'ready',
  });
}

void main().catch(() => {
  process.stderr.write('{"event":"api.fatal","outcome":"failed"}\n');
  process.exitCode = 1;
});
