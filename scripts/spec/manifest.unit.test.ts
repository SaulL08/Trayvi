import { describe, expect, it } from 'vitest';

import {
  integrationBranch,
  mergeWaves,
  ownershipViolations,
  parseBranch,
  parseManifest,
  streamBranch,
  validateManifest,
  validateManifestSet,
  type SpecManifest,
  type StreamDefinition,
} from './manifest.js';

const location = {
  phaseDirectory: 'phase-02-authentication',
  specDirectory: 'SPEC-001-session-rotation',
};

function stream(
  overrides: Partial<StreamDefinition> & Pick<StreamDefinition, 'id'>,
): StreamDefinition {
  return {
    title: `Stream ${overrides.id}`,
    owns: [`modules/sessions/src/${overrides.id}/`],
    dependsOn: [],
    migrations: [],
    acceptance: ['P2-AC-001'],
    verify: ['corepack pnpm test:unit'],
    ...overrides,
  };
}

function manifest(
  streams: readonly StreamDefinition[],
  overrides: Partial<SpecManifest> = {},
): SpecManifest {
  return {
    spec: 'SPEC-001-session-rotation',
    title: 'Session rotation',
    phase: 'phase-02-authentication',
    status: 'approved',
    base: 'main',
    streams,
    ...overrides,
  };
}

const codes = (issues: readonly { readonly code: string }[]) => issues.map((issue) => issue.code);

describe('spec manifest validation', () => {
  it('accepts disjoint streams with an acyclic dependency graph', () => {
    const valid = manifest([
      stream({ id: 'ws-a', migrations: ['0011'] }),
      stream({ id: 'ws-b' }),
      stream({ id: 'ws-c', dependsOn: ['ws-a', 'ws-b'] }),
    ]);

    expect(validateManifest(valid, location)).toEqual([]);
    expect(mergeWaves(valid)).toEqual([['ws-a', 'ws-b'], ['ws-c']]);
  });

  it('rejects overlapping ownership between streams, including directory nesting', () => {
    const issues = validateManifest(
      manifest([
        stream({ id: 'ws-a', owns: ['modules/sessions/'] }),
        stream({ id: 'ws-b', owns: ['modules/sessions/src/rotation.ts'] }),
      ]),
      location,
    );

    expect(codes(issues)).toEqual(['ownership']);
  });

  it('keeps integration-owned files, package manifests, and spec documents away from streams', () => {
    const issues = validateManifest(
      manifest([
        stream({
          id: 'ws-a',
          owns: [
            'pnpm-lock.yaml',
            'infra/database/migrations/0011_x.up.sql',
            'modules/sessions/package.json',
            'docs/phases/phase-02-authentication/specs/SPEC-001-session-rotation/tasks.md',
          ],
        }),
      ]),
      location,
    );

    expect(codes(issues)).toEqual(['ownership', 'ownership', 'ownership', 'ownership']);
  });

  it('rejects globs, parent traversal, and absolute ownership paths', () => {
    const issues = validateManifest(
      manifest([
        stream({ id: 'ws-a', owns: ['modules/**', '../outside/', '/etc/passwd', 'modules//x'] }),
      ]),
      location,
    );

    expect(codes(issues)).toEqual(['ownership', 'ownership', 'ownership', 'ownership']);
  });

  it('rejects dependency cycles, unknown dependencies, and duplicate migration reservations', () => {
    expect(
      codes(
        validateManifest(
          manifest([
            stream({ id: 'ws-a', dependsOn: ['ws-b'] }),
            stream({ id: 'ws-b', dependsOn: ['ws-a'] }),
          ]),
          location,
        ),
      ),
    ).toEqual(['dependency']);
    expect(
      codes(validateManifest(manifest([stream({ id: 'ws-a', dependsOn: ['ws-z'] })]), location)),
    ).toEqual(['dependency']);
    expect(
      codes(
        validateManifest(
          manifest([
            stream({ id: 'ws-a', migrations: ['0011'] }),
            stream({ id: 'ws-b', migrations: ['0011'] }),
          ]),
          location,
        ),
      ),
    ).toEqual(['migration']);
  });

  it('requires traceability, verification, naming, and location to match', () => {
    const issues = validateManifest(
      manifest([stream({ id: 'stream-1', acceptance: ['must be fast'], verify: [] })], {
        phase: 'phase-03-other',
      }),
      location,
    );

    expect(codes(issues).sort()).toEqual(['acceptance', 'spec-location', 'stream-id', 'verify']);
  });

  it('rejects specs that reuse a number or reserve the same migration while unfinished', () => {
    const first = manifest([stream({ id: 'ws-a', migrations: ['0011'] })]);
    const second = manifest([stream({ id: 'ws-a', migrations: ['0011'] })], {
      spec: 'SPEC-001-other',
    });
    const finished = manifest([stream({ id: 'ws-a', migrations: ['0011'] })], {
      spec: 'SPEC-002-done',
      status: 'integrated',
    });

    expect(codes(validateManifestSet([first, second]))).toEqual(['spec-id', 'migration']);
    expect(validateManifestSet([first, finished])).toEqual([]);
  });

  it('reports shape errors instead of throwing on untrusted JSON', () => {
    expect(codes(parseManifest([], 'x').issues)).toEqual(['manifest-shape']);
    expect(
      parseManifest({ spec: 'SPEC-001-a', status: 'done', streams: [{ id: 'ws-a' }] }, 'x').issues
        .length,
    ).toBeGreaterThan(3);
    expect(
      parseManifest(JSON.parse(JSON.stringify(manifest([stream({ id: 'ws-a' })]))), 'x').issues,
    ).toEqual([]);
  });
});

describe('stream branch ownership', () => {
  const owner = stream({
    id: 'ws-a',
    owns: ['modules/sessions/src/', 'docs/sessions.md'],
    migrations: ['0011'],
  });

  it('allows owned paths and the reserved migration pair only', () => {
    expect(
      ownershipViolations(owner, [
        'modules/sessions/src/rotation.ts',
        'docs/sessions.md',
        'infra/database/migrations/0011_session_rotation.up.sql',
        'infra/database/migrations/0011_session_rotation.down.sql',
      ]),
    ).toEqual([]);
  });

  it('reports shared files, other migrations, and lookalike prefixes', () => {
    expect(
      ownershipViolations(owner, [
        'pnpm-lock.yaml',
        'infra/database/migrations/0012_other.up.sql',
        'infra/database/migrations/00110_lookalike.up.sql',
        'modules/sessions/src-other/x.ts',
        'docs/sessions.md.bak',
      ]),
    ).toEqual([
      'pnpm-lock.yaml',
      'infra/database/migrations/0012_other.up.sql',
      'infra/database/migrations/00110_lookalike.up.sql',
      'modules/sessions/src-other/x.ts',
      'docs/sessions.md.bak',
    ]);
  });
});

describe('spec branch naming', () => {
  it('derives integration and stream branches that git can hold together', () => {
    expect(integrationBranch('SPEC-001-session-rotation')).toBe(
      'spec/001-session-rotation/integration',
    );
    expect(streamBranch('SPEC-001-session-rotation', 'ws-b')).toBe(
      'spec/001-session-rotation/ws-b',
    );
    expect(parseBranch('spec/001-session-rotation/ws-b')).toEqual({
      prefix: 'spec/001-session-rotation',
      role: 'ws-b',
    });
    expect(parseBranch('spec/001-session-rotation')).toBeUndefined();
    expect(parseBranch('fix/phase-01-remediation')).toBeUndefined();
  });
});
