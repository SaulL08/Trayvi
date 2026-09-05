import { describe, expect, it } from 'vitest';

import { findPotentialSecrets } from './scan-secrets.js';

describe('secret scanner', () => {
  it('detects strong provider-token and private-key signatures without returning values', () => {
    const accessKey = ['AKIA', '1234567890ABCDEF'].join('');
    const privateKeyHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const source = [accessKey, privateKeyHeader].join('\n');
    const findings = findPotentialSecrets(source, 'fixture');

    expect(findings).toEqual([
      { source: 'fixture', line: 1, pattern: 'aws-access-key' },
      { source: 'fixture', line: 2, pattern: 'private-key' },
    ]);
    expect(JSON.stringify(findings)).not.toContain(accessKey);
  });
});
