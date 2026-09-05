import { describe, expect, it, vi } from 'vitest';

import { FoundationMetrics } from '@trayvi/observability';
import type { Logger } from '@trayvi/observability';

import { WorkerLifecycle } from '../src/worker-lifecycle';

describe('worker lifecycle', () => {
  it('reports foundation mode without simulating outbox processing', () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const metrics = new FoundationMetrics(true);
    const lifecycle = new WorkerLifecycle(logger, metrics);

    lifecycle.onApplicationBootstrap();
    lifecycle.onApplicationShutdown('SIGTERM');

    expect(logger.info).toHaveBeenCalledWith('worker.started', {
      mode: 'foundation',
      outboxProcessing: 'not_enabled',
      outcome: 'ready',
    });
    expect(metrics.snapshot().workerLifecycle).toEqual({
      'event=started': 1,
      'event=stopped': 1,
    });
  });
});
