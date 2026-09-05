import { describe, expect, it } from 'vitest';

import {
  createRequestContext,
  getRequestContext,
  normalizeInboundId,
  runWithRequestContext,
} from '../src';

describe('request context IDs', () => {
  it('accepts canonical UUID input', () => {
    const id = '018f4f7a-3c2b-7b11-8abc-0123456789ab';
    expect(normalizeInboundId(id)).toBe(id);
  });

  it.each(['short', 'header\r\ninjection', 'x'.repeat(10_000), ['uuid']])(
    'replaces malformed input',
    (input) => {
      const output = normalizeInboundId(input);
      expect(output).toHaveLength(36);
      expect(output).not.toBe(input);
    },
  );

  it('propagates one context through asynchronous work', async () => {
    const context = createRequestContext(undefined, undefined);
    const observed = await runWithRequestContext(context, async () => {
      await Promise.resolve();
      return getRequestContext();
    });

    expect(observed).toEqual(context);
  });
});
