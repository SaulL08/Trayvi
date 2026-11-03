import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SubjectLabel } from '../../src/contracts/rate-limit';
import { HmacSubjectCommitter } from '../../src/infrastructure/rate-limit/subject-committer';
import { ConfiguredAuthKeyring } from '../../src/infrastructure/shared/auth-keyring';

const subjectKey = Buffer.alloc(32, 0x41);

function committer(material = subjectKey): HmacSubjectCommitter {
  return new HmacSubjectCommitter(
    new ConfiguredAuthKeyring([
      {
        purpose: 'auth-contact-fingerprint',
        version: 'v1',
        state: 'PRIMARY',
        material: Buffer.alloc(32, 1),
      },
      {
        purpose: 'auth-contact-kek',
        version: 'v1',
        state: 'PRIMARY',
        material: Buffer.alloc(32, 2),
      },
      {
        purpose: 'auth-otp-commitment',
        version: 'v1',
        state: 'PRIMARY',
        material: Buffer.alloc(32, 3),
      },
      { purpose: 'auth-subject-commitment', version: 'v1', state: 'PRIMARY', material },
    ]),
  );
}

describe('HmacSubjectCommitter (R-17)', () => {
  it('computes HMAC-SHA-256 over the NUL-separated domain, label, and value', () => {
    const expected = createHmac('sha256', subjectKey)
      .update(Buffer.from('trayvi.auth-subject\u0000network-prefix\u0000203.0.113.0/24', 'utf8'))
      .digest();
    expect(committer().commit('network-prefix', '203.0.113.0/24').equals(expected)).toBe(true);
  });

  it('separates labels, values, and keys, and never exposes the raw value', () => {
    const value = '+18095550100';
    const labels: readonly SubjectLabel[] = [
      'installation',
      'network-prefix',
      'contact',
      'account',
      'global',
    ];
    const outputs = labels.map((label) => committer().commit(label, value).toString('hex'));
    expect(new Set(outputs).size).toBe(labels.length);
    expect(
      committer().commit('contact', value).equals(committer().commit('contact', '+18095550101')),
    ).toBe(false);
    expect(
      committer()
        .commit('contact', value)
        .equals(committer(Buffer.alloc(32, 0x42)).commit('contact', value)),
    ).toBe(false);
    const commitment = committer().commit('contact', value);
    expect(commitment.byteLength).toBe(32);
    expect(commitment.toString('hex')).not.toContain(Buffer.from(value).toString('hex'));
  });

  it('accepts binary values such as fingerprints and is deterministic', () => {
    const fingerprint = Buffer.alloc(32, 0x99);
    expect(
      committer()
        .commit('contact', fingerprint)
        .equals(committer().commit('contact', Buffer.from(fingerprint))),
    ).toBe(true);
  });

  it('rejects unknown labels and empty or oversized values', () => {
    expect(() => committer().commit('phone' as SubjectLabel, 'x')).toThrow('SUBJECT_LABEL_INVALID');
    expect(() => committer().commit('contact', '')).toThrow('SUBJECT_VALUE_INVALID');
    expect(() => committer().commit('contact', Buffer.alloc(257))).toThrow('SUBJECT_VALUE_INVALID');
  });
});
