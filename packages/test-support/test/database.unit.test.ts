import { describe, expect, it, vi } from 'vitest';

import { closeInitializedDatabaseClients } from '../src/database';

describe('database test resource cleanup', () => {
  it('preserves a setup failure while safely closing only initialized clients', async () => {
    const close = vi.fn(() => Promise.resolve());
    const setupFailure = new Error('DELIBERATE_SETUP_FAILURE');

    const setup = async (): Promise<void> => {
      try {
        throw setupFailure;
      } catch (error: unknown) {
        await closeInitializedDatabaseClients({ migrator: { close } });
        throw error;
      }
    };

    await expect(setup()).rejects.toBe(setupFailure);
    expect(close).toHaveBeenCalledOnce();
  });
});
