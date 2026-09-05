import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkRepositoryArchitecture, inspectArchitectureFiles } from './check-boundaries.js';

describe('architecture boundary enforcement', () => {
  it('accepts the real Phase 0 dependency graph', async () => {
    await expect(checkRepositoryArchitecture()).resolves.toEqual([]);
  });

  it('detects the intentionally forbidden foundation-to-app fixture', async () => {
    const fixture = resolve('packages/test-support/fixtures/invalid-boundary/invalid-import.ts');
    const violations = await inspectArchitectureFiles(process.cwd(), [fixture]);

    expect(violations).toContainEqual(expect.objectContaining({ code: 'FOUNDATION_IMPORTS_APP' }));
  });
});
