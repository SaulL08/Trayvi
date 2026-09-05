import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface ProcessResult {
  readonly code: number | null;
  readonly output: string;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise<void>((resolveClosed, reject) =>
    server.close((error) => (error ? reject(error) : resolveClosed())),
  );
  return address.port;
}

async function startSignalStop(
  entryPoint: string,
  service: 'api' | 'worker',
  expectedStartedEvent: string,
): Promise<ProcessResult> {
  const port = await availablePort();
  const child = spawn(process.execPath, [resolve(entryPoint)], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: service,
      SERVICE_VERSION: 'process-integration',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
      OTEL_ENABLED: 'false',
      METRICS_ENABLED: 'true',
      SHUTDOWN_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  await new Promise<void>((resolveStarted, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 5_000);
    const inspect = (): void => {
      if (output.includes(expectedStartedEvent)) {
        clearTimeout(deadline);
        resolveStarted();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`Process exited before startup with ${String(code)}: ${output}`));
    });
  });

  child.kill('SIGTERM');
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Shutdown exceeded its bound: ${output}`));
    }, 4_000);
    child.once('exit', (exitCode) => {
      clearTimeout(deadline);
      resolveExit(exitCode);
    });
  });
  return { code, output };
}

describe.skipIf(process.platform === 'win32')('compiled process graceful shutdown', () => {
  it.each([
    ['apps/api/dist/main.js', 'api', 'api.started', 'api.stopped'],
    ['apps/worker/dist/main.js', 'worker', 'worker.started', 'worker.stopped'],
  ] as const)(
    'starts, receives SIGTERM, and stops %s',
    async (entry, service, started, stopped) => {
      const result = await startSignalStop(entry, service, started);

      expect(result.code).toBe(0);
      expect(result.output).toContain(stopped);
      expect(result.output).not.toContain('shutdown.timeout');
    },
  );
});
