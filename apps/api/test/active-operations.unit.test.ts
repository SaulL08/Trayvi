import { describe, expect, it } from 'vitest';

import { ActiveOperationRegistry } from '../src/active-operations';

describe('active operation registry', () => {
  it('does not become idle until tracked work actually settles', async () => {
    const registry = new ActiveOperationRegistry();
    let release: (() => void) | undefined;
    const operation = registry.track(() => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();

    expect(registry.size).toBe(1);
    let drained = false;
    const idle = registry.whenIdle().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await operation;
    await idle;
    expect(registry.size).toBe(0);
  });

  it('contains synchronous failures while releasing the active token', async () => {
    const registry = new ActiveOperationRegistry();

    await expect(
      registry.track(() => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');
    expect(registry.size).toBe(0);
    await expect(registry.whenIdle()).resolves.toBeUndefined();
  });
});
