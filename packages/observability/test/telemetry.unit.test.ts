import { describe, expect, it, vi } from 'vitest';

import type { Logger, TelemetryProvider } from '../src';
import { shutdownTelemetrySafely } from '../src';

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  };
}

describe('telemetry failure isolation', () => {
  it('contains exporter flush and shutdown failures', async () => {
    const logger = testLogger();
    const provider: TelemetryProvider = {
      forceFlush: () => Promise.reject(new Error('Bearer exporter-secret')),
      shutdown: () => Promise.reject(new Error('shutdown failed')),
    };

    await expect(shutdownTelemetrySafely(provider, 100, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('exporter-secret');
  });

  it('bounds a hanging provider', async () => {
    const logger = testLogger();
    const never = new Promise<void>(() => undefined);
    const provider: TelemetryProvider = {
      forceFlush: () => never,
      shutdown: () => Promise.resolve(),
    };

    const started = Date.now();
    await shutdownTelemetrySafely(provider, 25, logger);

    expect(Date.now() - started).toBeLessThan(250);
    expect(logger.warn).toHaveBeenCalledWith('telemetry.flush.failed', { outcome: 'timeout' });
  });
});
