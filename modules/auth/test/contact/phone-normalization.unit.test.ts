import { describe, expect, it } from 'vitest';

import type { PhoneNumberingPolicy } from '../../src/contracts/contact';
import {
  E164PhoneNormalizer,
  PhoneNumberingPolicyError,
} from '../../src/domain/contact/phone-normalization';

const configA: PhoneNumberingPolicy = {
  defaultCallingCode: '1',
  callingCodes: [{ code: '1', nationalNumberLength: 10, destinationCodes: ['809', '829', '849'] }],
};
const configB: PhoneNumberingPolicy = { callingCodes: configA.callingCodes };

const vectors: readonly (readonly [string, PhoneNumberingPolicy, string | undefined, string])[] = [
  ['+18095550100', configA, '+18095550100', 'OK'],
  ['+1 (809) 555-0100', configA, '+18095550100', 'OK'],
  ['809.555.0100', configA, '+18095550100', 'OK'],
  ['8095550100', configB, undefined, 'MISSING_CALLING_CODE'],
  ['+12125550100', configA, undefined, 'UNSUPPORTED_REGION'],
  ['+448095550100', configA, undefined, 'UNSUPPORTED_REGION'],
  ['+1809555010', configA, undefined, 'INVALID_LENGTH'],
  ['+1809555010012345', configA, undefined, 'INVALID_LENGTH'],
  ['+1８０９5550100', configA, undefined, 'NON_ASCII_DIGIT'],
  ['+1809/5550100', configA, undefined, 'UNSUPPORTED_CHARACTER'],
  ['', configA, undefined, 'INVALID_LENGTH'],
  ['     ', configA, undefined, 'INVALID_LENGTH'],
  ['1'.repeat(33), configA, undefined, 'INPUT_TOO_LONG'],
];

function outcome(normalizer: E164PhoneNormalizer, input: unknown): [string | undefined, string] {
  const result = normalizer.normalize(input);
  return result.ok ? [result.value.canonical, 'OK'] : [undefined, result.code];
}

describe('e164-v1 phone normalization', () => {
  it.each(vectors)('PLAN §6.1 vector %j', (input, policy, canonical, code) => {
    expect(outcome(new E164PhoneNormalizer(policy), input)).toEqual([canonical, code]);
  });

  it('counts Unicode scalar values, not UTF-16 code units, for the length limit', () => {
    const normalizer = new E164PhoneNormalizer(configA);
    const thirtyTwoScalars = '\u{1D7CE}'.repeat(32); // mathematical digit zero, astral plane
    expect(outcome(normalizer, thirtyTwoScalars)[1]).toBe('NON_ASCII_DIGIT');
    expect(outcome(normalizer, `${thirtyTwoScalars}1`)[1]).toBe('INPUT_TOO_LONG');
  });

  it('rejects control characters, lone surrogates, misplaced plus signs, and non-strings', () => {
    const normalizer = new E164PhoneNormalizer(configA);
    for (const input of [
      '+1809555\u00000100',
      '+1809555\t0100',
      '+1809\uD8005550100',
      '1+8095550100',
      '++18095550100',
    ]) {
      expect(outcome(normalizer, input)[1]).toBe('UNSUPPORTED_CHARACTER');
    }
    for (const input of [
      18095550100,
      null,
      undefined,
      ['+18095550100'],
      { canonical: '+18095550100' },
    ]) {
      expect(outcome(normalizer, input)[1]).toBe('UNSUPPORTED_CHARACTER');
    }
  });

  it('removes only the five allowed separators and keeps other whitespace an error', () => {
    const normalizer = new E164PhoneNormalizer(configA);
    expect(outcome(normalizer, '(809) 555.01-00')).toEqual(['+18095550100', 'OK']);
    expect(outcome(normalizer, '+1 8095550100')[1]).toBe('UNSUPPORTED_CHARACTER');
    expect(outcome(normalizer, '+1_8095550100')[1]).toBe('UNSUPPORTED_CHARACTER');
  });

  it('chooses the longest configured calling code and applies its national length', () => {
    const normalizer = new E164PhoneNormalizer({
      callingCodes: [
        { code: '1', nationalNumberLength: 10, destinationCodes: ['809', '829', '849'] },
        { code: '18', nationalNumberLength: 8 },
      ],
    });
    expect(outcome(normalizer, '+1812345678')).toEqual(['+1812345678', 'OK']);
    expect(outcome(normalizer, '+18095550100')[1]).toBe('INVALID_LENGTH');
  });

  it('is idempotent for every accepted value', () => {
    const normalizer = new E164PhoneNormalizer(configA);
    const seeds = ['+18095550100', '(829) 555-0199', '849.555.0101', '+1 809 555 0102'];
    for (let index = 0; index < 200; index += 1) {
      const seed = seeds[index % seeds.length] ?? '';
      const once = normalizer.normalize(seed);
      expect(once.ok).toBe(true);
      if (!once.ok) continue;
      const twice = normalizer.normalize(once.value.canonical);
      expect(twice).toEqual(once);
    }
  });

  it('rejects an invalid numbering policy at construction', () => {
    const invalid: readonly PhoneNumberingPolicy[] = [
      { callingCodes: [] },
      { defaultCallingCode: '44', callingCodes: configA.callingCodes },
      { callingCodes: [{ code: '1a', nationalNumberLength: 10 }] },
      { callingCodes: [{ code: '1', nationalNumberLength: 20 }] },
      {
        callingCodes: [
          { code: '1', nationalNumberLength: 10 },
          { code: '1', nationalNumberLength: 9 },
        ],
      },
    ];
    for (const policy of invalid) {
      expect(() => new E164PhoneNormalizer(policy)).toThrow(PhoneNumberingPolicyError);
    }
  });
});
