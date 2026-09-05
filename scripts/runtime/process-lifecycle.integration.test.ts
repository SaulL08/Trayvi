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

  // 'close' waits for the output pipes too; 'exit' may precede their final data.
  const closed = new Promise<number | null>((resolveClosed) => {
    child.once('close', resolveClosed);
  });

  try {
    await new Promise<void>((resolveStarted, reject) => {
      const cleanup = (): void => {
        clearTimeout(deadline);
        child.stdout.off('data', inspect);
        child.stderr.off('data', inspect);
        child.off('exit', earlyExit);
        child.off('error', startupError);
      };
      const startupError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const earlyExit = (code: number | null): void => {
        startupError(new Error(`Process exited before startup with ${String(code)}: ${output}`));
      };
      const inspect = (): void => {
        if (output.includes(expectedStartedEvent)) {
          cleanup();
          resolveStarted();
        }
      };
      const deadline = setTimeout(
        () => startupError(new Error(`Startup timed out: ${output}`)),
        5_000,
      );
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('exit', earlyExit);
      child.once('error', startupError);
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Shutdown exceeded its bound: ${output}`));
        }, 4_000);
      });
      expect(child.kill('SIGTERM')).toBe(true);
      const code = await Promise.race([closed, timedOut]);
      return { code, output };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

describe.skipIf(process.platform === 'win32')('compiled process graceful shutdown', () => {
  it.each([
    ['apps/api/dist/main.js', 'api', 'api.started', 'api.stopped'],
    ['apps/worker/dist/main.js', 'worker', 'worker.process.ready', 'worker.stopped'],
  ] as const)(
    'starts, receives SIGTERM, and stops %s',
    async (entry, service, started, stopped) => {
      const result = await startSignalStop(entry, service, started);

      expect(result.code).toBe(0);
      expect(result.output).toContain(`${service}.started`);
      expect(result.output).toContain(`${service}.draining`);
      expect(result.output).toContain('SIGTERM');
      expect(result.output).toContain(stopped);
      expect(result.output.indexOf(`${service}.started`)).toBeLessThan(
        result.output.indexOf(`${service}.draining`),
      );
      expect(result.output.indexOf(`${service}.draining`)).toBeLessThan(
        result.output.indexOf(stopped),
      );
      expect(result.output).not.toContain('shutdown.timeout');
    },
  );
});
