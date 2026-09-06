import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkRepositoryArchitecture,
  inspectArchitectureFiles,
  inspectWorkspacePackageGraph,
} from './check-boundaries.js';

describe('architecture boundary enforcement', () => {
  it('accepts the real Phase 0 dependency graph', async () => {
    await expect(checkRepositoryArchitecture()).resolves.toEqual([]);
  });

  it('detects the intentionally forbidden foundation-to-app fixture', async () => {
    const fixture = resolve('packages/test-support/fixtures/invalid-boundary/invalid-import.ts');
    const violations = await inspectArchitectureFiles(process.cwd(), [fixture]);

    expect(violations).toContainEqual(expect.objectContaining({ code: 'FOUNDATION_IMPORTS_APP' }));
  });

  it('detects package, deep, re-export, dynamic, and relative application imports', async () => {
    const fixtures = [
      'packages/test-support/fixtures/invalid-boundary/foundation-package-import.ts',
      'packages/test-support/fixtures/invalid-boundary/foundation-deep-import.ts',
      'packages/test-support/fixtures/invalid-boundary/foundation-dynamic-import.ts',
      'packages/test-support/fixtures/invalid-boundary/invalid-import.ts',
    ].map((file) => resolve(file));
    const violations = await inspectArchitectureFiles(process.cwd(), fixtures);

    expect(
      violations.filter((violation) => violation.code === 'FOUNDATION_IMPORTS_APP'),
    ).toHaveLength(fixtures.length);
  });

  it('detects indirect process environment access through global, local, and destructured aliases', async () => {
    const fixture = resolve(
      'packages/test-support/fixtures/invalid-boundary/environment-aliases.ts',
    );
    const violations = await inspectArchitectureFiles(process.cwd(), [fixture]);

    expect(violations).toContainEqual(expect.objectContaining({ code: 'DIRECT_ENV_ACCESS' }));
  });

  it('enforces application boundaries from package manifests', async () => {
    const fixture = resolve('scripts/architecture/fixtures/workspace');

    await expect(inspectWorkspacePackageGraph(fixture)).resolves.toContainEqual(
      expect.objectContaining({
        code: 'FOUNDATION_DEPENDS_ON_APP',
        file: 'packages/config/package.json',
      }),
    );
  });
});
