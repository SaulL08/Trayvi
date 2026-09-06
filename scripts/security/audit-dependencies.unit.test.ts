import { describe, expect, it } from 'vitest';

import { evaluateDependencyAudit } from './audit-dependencies.js';

const moderateAudit = {
  auditReportVersion: 2,
  vulnerabilities: {
    example: {
      name: 'example',
      severity: 'moderate',
      isDirect: true,
      via: [
        {
          source: 1234,
          name: 'example',
          dependency: 'example',
          title: 'Example advisory',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'moderate',
          range: '<2.0.0',
        },
      ],
      range: '<2.0.0',
      nodes: ['node_modules/example'],
      fixAvailable: { name: 'example', version: '2.0.0', isSemVerMajor: true },
    },
  },
};

describe('dependency audit policy', () => {
  it('fails a Moderate advisory without complete current triage and retains required identity', () => {
    const report = evaluateDependencyAudit(moderateAudit, [], {
      dependencyTypes: new Map([['example', 'development']]),
      installedVersions: new Map([['example', ['1.4.0']]]),
      now: new Date('2026-09-06T00:00:00Z'),
    });

    expect(report.passed).toBe(false);
    expect(report.advisories[0]).toMatchObject({
      advisoryId: 'GHSA-aaaa-bbbb-cccc',
      package: 'example',
      installedVersion: '1.4.0',
      affectedRange: '<2.0.0',
      fixedVersion: '2.0.0',
      dependencyType: 'development',
      severity: 'moderate',
      source: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      triage: null,
    });
  });

  it('accepts a Moderate advisory only with an owned, reviewed, unexpired disposition', () => {
    const report = evaluateDependencyAudit(
      moderateAudit,
      [
        {
          advisoryId: 'GHSA-aaaa-bbbb-cccc',
          package: 'example',
          installedVersion: '1.4.0',
          affectedRange: '<2.0.0',
          fixedVersion: '2.0.0',
          dependencyType: 'development',
          severity: 'moderate',
          source: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          disposition: 'MITIGATE',
          justification: 'The affected code path is unavailable in this build configuration.',
          owner: 'Security owner',
          reviewer: 'Repository maintainer',
          decidedOn: '2026-09-06',
          reviewBy: '2026-10-06',
        },
      ],
      { now: new Date('2026-09-06T00:00:00Z') },
    );

    expect(report.passed).toBe(true);
    expect(report.advisories[0]?.triage?.disposition).toBe('MITIGATE');
  });

  it('blocks High and Critical advisories regardless of triage', () => {
    const highAudit = structuredClone(moderateAudit);
    highAudit.vulnerabilities.example.severity = 'high';
    const advisory = highAudit.vulnerabilities.example.via[0];
    if (advisory) advisory.severity = 'high';

    expect(evaluateDependencyAudit(highAudit, []).passed).toBe(false);
  });

  it('normalizes the pnpm v1 advisory format with installed and patched versions', () => {
    const report = evaluateDependencyAudit(
      {
        advisories: {
          '1119441': {
            findings: [
              {
                version: '11.1.0',
                paths: ['packages__observability>uuid'],
                dev: false,
                optional: false,
              },
            ],
            id: 1119441,
            title: 'Bounds check',
            module_name: 'uuid',
            vulnerable_versions: '<11.1.1',
            patched_versions: '>=11.1.1',
            severity: 'moderate',
            url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
          },
        },
      },
      [],
      { dependencyTypes: new Map([['uuid', 'production']]) },
    );

    expect(report.advisories[0]).toMatchObject({
      advisoryId: 'GHSA-w5hq-g745-h8pq',
      package: 'uuid',
      installedVersion: '11.1.0',
      affectedRange: '<11.1.1',
      fixedVersion: '>=11.1.1',
      dependencyType: 'production',
      direct: true,
      severity: 'moderate',
    });
  });
});
