import { describe, expect, it } from 'vitest';

import {
  DocumentNormalizationError,
  normalizeDominicanCedula,
  structuralAssessmentNotPerformed,
} from '../src/domain/document-normalization';

describe('do-cedula-v1 normalization', () => {
  const accepted = [
    '00112345678',
    '001-1234567-8',
    ' 001-1234567-8 ',
    '001 - 1234567 - 8',
    '001\t1234567\r\n8',
  ] as const;

  it.each(accepted)('normalizes %j deterministically', (input) => {
    expect(normalizeDominicanCedula(input)).toEqual({
      kind: 'NORMALIZED_FORMAT',
      profile: 'do-cedula-v1',
      canonicalValue: '00112345678',
    });
  });

  it.each([
    ['001‐1234567‐8', 'UNSUPPORTED_CHARACTER'],
    ['００１１２３４５６７８', 'NON_ASCII_DIGIT'],
    ['001.1234567.8', 'UNSUPPORTED_CHARACTER'],
    ['0011234567', 'INVALID_LENGTH'],
    ['001123456789', 'INVALID_LENGTH'],
    ['', 'INVALID_LENGTH'],
    [' '.repeat(65), 'INPUT_TOO_LONG'],
    ['001\u000012345678', 'INVALID_CONTROL_CHARACTER'],
    ['\ud80000112345678', 'INVALID_UNICODE'],
  ])('rejects malformed input without echoing it: %j', (input, code) => {
    let caught: unknown;
    try {
      normalizeDominicanCedula(input);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentNormalizationError);
    expect(caught).toMatchObject({ code });
    if (input.length > 0) {
      expect(String(caught)).not.toContain(input);
    }
  });

  it('is idempotent over deterministic formatting variants', () => {
    let state = 0x5eed1234;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const canonical = '00112345678';
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const formatted = Array.from(canonical, (digit) => {
        const prefix = ['', ' ', '-', '\t'][next() % 4] ?? '';
        const suffix = ['', ' ', '-', '\n'][next() % 4] ?? '';
        return `${prefix}${digit}${suffix}`;
      }).join('');
      const normalized = normalizeDominicanCedula(formatted);
      expect(normalizeDominicanCedula(normalized.canonicalValue)).toEqual(normalized);
    }
  });

  it('keeps format normalization distinct from unapproved structural validation', () => {
    const normalized = normalizeDominicanCedula('001-1234567-8');
    expect(structuralAssessmentNotPerformed(normalized)).toEqual({
      kind: 'STRUCTURAL_ASSESSMENT',
      profile: 'do-cedula-v1',
      status: 'NOT_PERFORMED',
      ruleSetVersion: null,
      reason: 'NO_APPROVED_RULESET',
    });
    expect(normalized).not.toHaveProperty('verified');
  });

  it('rejects non-string values', () => {
    expect(() => normalizeDominicanCedula(112345678)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TYPE' }),
    );
  });
});
