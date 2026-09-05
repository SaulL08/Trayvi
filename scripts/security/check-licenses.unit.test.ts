import { describe, expect, it } from 'vitest';

import { evaluateLicenseRecords } from './check-licenses.js';

describe('dependency license policy', () => {
  it('accepts allowlisted permissive metadata and rejects absent/strong-copyleft metadata', () => {
    const findings = evaluateLicenseRecords([
      { name: 'permissive', version: '1.0.0', license: 'MIT' },
      { name: 'missing', version: '1.0.0', license: '' },
      { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0-only' },
    ]);

    expect(findings).toEqual([
      {
        name: 'missing',
        version: '1.0.0',
        license: '',
        reason: 'missing-license',
      },
      {
        name: 'copyleft',
        version: '1.0.0',
        license: 'GPL-3.0-only',
        reason: 'prohibited-license',
      },
    ]);
  });
});
