import { describe, expect, it } from 'vitest';

import { RuntimeState } from '../src/runtime-state';

describe('runtime lifecycle', () => {
  it('becomes unready before shutdown completes', () => {
    const runtime = new RuntimeState();
    runtime.beginInitialization();
    runtime.markReady();
    expect(runtime.acceptsTraffic()).toBe(true);

    runtime.beginDraining();
    expect(runtime.acceptsTraffic()).toBe(false);

    runtime.markStopped();
    expect(runtime.lifecycle).toBe('STOPPED');
  });
});
