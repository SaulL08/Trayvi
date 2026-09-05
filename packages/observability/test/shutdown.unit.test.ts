import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../src';
import { ShutdownCoordinator, StructuredLogger } from '../src';

describe('shutdown coordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('runs tasks once in reverse registration order', async () => {
    const calls: string[] = [];
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const coordinator = new ShutdownCoordinator(logger, 500);
    coordinator.register('first', () => calls.push('first'));
    coordinator.register('second', () => calls.push('second'));

    await Promise.all([coordinator.shutdown('SIGTERM'), coordinator.shutdown('SIGINT')]);

    expect(calls).toEqual(['second', 'first']);
    expect(logger.flush).toHaveBeenCalledOnce();
  });

  it('stops waiting at the configured bound', async () => {
    vi.useFakeTimers();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const coordinator = new ShutdownCoordinator(logger, 500);
    coordinator.register('never-finishes', () => new Promise<void>(() => undefined));

    const shutdown = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(500);
    await shutdown;

    expect(logger.info).toHaveBeenLastCalledWith('runtime.stopped', { outcome: 'timeout' });
    expect(logger.flush).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('bounds a stalled task with real time and emits a safe structured timeout log', async () => {
    const destination = new PassThrough();
    let output = '';
    destination.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'shutdown-test',
      environment: 'test',
      version: 'test',
      level: 'info',
      format: 'json',
      destination,
    });
    const coordinator = new ShutdownCoordinator(logger, 100);
    coordinator.register('stalled-task', () => new Promise<void>(() => undefined));
    // Keep the event loop alive independently of the coordinator's unref timer.
    const watchdog = setTimeout(() => undefined, 2_000);
    try {
      const started = performance.now();
      await coordinator.shutdown('SIGTERM');
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1_000);
      const records = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.at(-1)).toMatchObject({ event: 'runtime.stopped', outcome: 'timeout' });
      expect(records.at(-1)).not.toHaveProperty('error');
      expect(output).not.toContain('stalled-task');
    } finally {
      clearTimeout(watchdog);
      destination.destroy();
    }
  });
});
