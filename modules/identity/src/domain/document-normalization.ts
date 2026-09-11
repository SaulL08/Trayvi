export const DOMINICAN_CEDULA_PROFILE = 'do-cedula-v1' as const;

export type DocumentNormalizationErrorCode =
  | 'INVALID_TYPE'
  | 'INVALID_UNICODE'
  | 'INPUT_TOO_LONG'
  | 'INVALID_CONTROL_CHARACTER'
  | 'NON_ASCII_DIGIT'
  | 'UNSUPPORTED_CHARACTER'
  | 'INVALID_LENGTH';

export interface NormalizedDocument {
  readonly kind: 'NORMALIZED_FORMAT';
  readonly profile: typeof DOMINICAN_CEDULA_PROFILE;
  readonly canonicalValue: string;
}

export interface DocumentStructuralAssessment {
  readonly kind: 'STRUCTURAL_ASSESSMENT';
  readonly profile: typeof DOMINICAN_CEDULA_PROFILE;
  readonly status: 'NOT_PERFORMED';
  readonly ruleSetVersion: null;
  readonly reason: 'NO_APPROVED_RULESET';
}

export class DocumentNormalizationError extends Error {
  readonly code: DocumentNormalizationErrorCode;

  constructor(code: DocumentNormalizationErrorCode) {
    super('Identity document format is invalid.');
    this.name = 'DocumentNormalizationError';
    this.code = code;
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function removable(character: string): boolean {
  return [' ', '\t', '\r', '\n', '-'].includes(character);
}

export function normalizeDominicanCedula(input: unknown): NormalizedDocument {
  if (typeof input !== 'string') throw new DocumentNormalizationError('INVALID_TYPE');
  if (!isWellFormedUnicode(input)) throw new DocumentNormalizationError('INVALID_UNICODE');

  const characters = Array.from(input);
  if (characters.length > 64) throw new DocumentNormalizationError('INPUT_TOO_LONG');

  let canonicalValue = '';
  for (const character of characters) {
    if (removable(character)) continue;
    if (/\p{Cc}/u.test(character)) {
      throw new DocumentNormalizationError('INVALID_CONTROL_CHARACTER');
    }
    if (/^[0-9]$/u.test(character)) {
      canonicalValue += character;
      continue;
    }
    if (/\p{Nd}/u.test(character)) {
      throw new DocumentNormalizationError('NON_ASCII_DIGIT');
    }
    throw new DocumentNormalizationError('UNSUPPORTED_CHARACTER');
  }

  if (canonicalValue.length !== 11) {
    throw new DocumentNormalizationError('INVALID_LENGTH');
  }
  return { kind: 'NORMALIZED_FORMAT', profile: DOMINICAN_CEDULA_PROFILE, canonicalValue };
}

export function structuralAssessmentNotPerformed(
  document: NormalizedDocument,
): DocumentStructuralAssessment {
  return {
    kind: 'STRUCTURAL_ASSESSMENT',
    profile: document.profile,
    status: 'NOT_PERFORMED',
    ruleSetVersion: null,
    reason: 'NO_APPROVED_RULESET',
  };
}
