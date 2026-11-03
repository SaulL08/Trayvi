import {
  PHONE_NORMALIZATION_PROFILE,
  type CallingCodePolicy,
  type NormalizedPhone,
  type PhoneNormalizationFailure,
  type PhoneNormalizationResult,
  type PhoneNormalizer,
  type PhoneNumberingPolicy,
} from '../../contracts/contact';

const MAX_SCALAR_VALUES = 32;
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;
const REMOVABLE = /[ \-().]/gu;
const CONTROL = /\p{Cc}/u;
const UNICODE_DIGIT = /\p{Nd}/u;
const ASCII_DIGITS = /^[0-9]*$/u;

export class PhoneNumberingPolicyError extends Error {
  constructor() {
    super('PHONE_NUMBERING_POLICY_INVALID');
    this.name = 'PhoneNumberingPolicyError';
  }
}

function fail(code: PhoneNormalizationFailure): PhoneNormalizationResult {
  return { ok: false, code };
}

function validatePolicy(policy: PhoneNumberingPolicy): readonly CallingCodePolicy[] {
  const codes = [...policy.callingCodes];
  const seen = new Set<string>();
  for (const entry of codes) {
    const destinations = entry.destinationCodes ?? [];
    if (
      !/^[0-9]{1,3}$/u.test(entry.code) ||
      seen.has(entry.code) ||
      !Number.isSafeInteger(entry.nationalNumberLength) ||
      entry.nationalNumberLength < 1 ||
      entry.code.length + entry.nationalNumberLength < MIN_E164_DIGITS ||
      entry.code.length + entry.nationalNumberLength > MAX_E164_DIGITS ||
      destinations.some(
        (destination) =>
          !/^[0-9]{1,4}$/u.test(destination) || destination.length > entry.nationalNumberLength,
      )
    ) {
      throw new PhoneNumberingPolicyError();
    }
    seen.add(entry.code);
  }
  if (
    codes.length === 0 ||
    (policy.defaultCallingCode !== undefined && !seen.has(policy.defaultCallingCode))
  ) {
    throw new PhoneNumberingPolicyError();
  }
  // Longest prefix first, so step 7 picks the longest configured calling code.
  return codes.sort((left, right) => right.code.length - left.code.length);
}

/**
 * PLAN §6 `e164-v1`. The steps below follow the plan's numbering exactly; the allowlist of calling
 * codes is configuration, so a new market needs no code change. Format validity never proves
 * possession.
 */
export class E164PhoneNormalizer implements PhoneNormalizer {
  readonly #callingCodes: readonly CallingCodePolicy[];
  readonly #defaultCallingCode: CallingCodePolicy | undefined;

  constructor(policy: PhoneNumberingPolicy) {
    this.#callingCodes = validatePolicy(policy);
    this.#defaultCallingCode = this.#callingCodes.find(
      (entry) => entry.code === policy.defaultCallingCode,
    );
  }

  normalize(input: unknown): PhoneNormalizationResult {
    // 1. Strings only, at most 32 Unicode scalar values. A non-string is not a phone number.
    if (typeof input !== 'string') return fail('UNSUPPORTED_CHARACTER');
    const scalars = Array.from(input);
    if (scalars.length > MAX_SCALAR_VALUES) return fail('INPUT_TOO_LONG');
    // A lone surrogate is not a Unicode scalar value.
    if (
      scalars.some((scalar) => {
        const codePoint = scalar.codePointAt(0) ?? 0;
        return codePoint >= 0xd800 && codePoint <= 0xdfff;
      })
    ) {
      return fail('UNSUPPORTED_CHARACTER');
    }

    // 2. Control characters.
    if (CONTROL.test(input)) return fail('UNSUPPORTED_CHARACTER');

    // 3. Remove only space, hyphen-minus, parentheses, and full stop.
    const compact = input.replace(REMOVABLE, '');

    // 4. Non-ASCII decimal digits, then anything other than one leading "+" and ASCII digits.
    const characters = Array.from(compact);
    if (
      characters.some((character) => UNICODE_DIGIT.test(character) && !/[0-9]/u.test(character))
    ) {
      return fail('NON_ASCII_DIGIT');
    }
    const hasPlus = compact.startsWith('+');
    let digits = hasPlus ? compact.slice(1) : compact;
    if (!ASCII_DIGITS.test(digits)) return fail('UNSUPPORTED_CHARACTER');

    // 5. Apply the default calling code to a bare national number of the configured length.
    if (!hasPlus) {
      if (!this.#defaultCallingCode) return fail('MISSING_CALLING_CODE');
      if (digits.length !== this.#defaultCallingCode.nationalNumberLength) {
        return fail('INVALID_LENGTH');
      }
      digits = `${this.#defaultCallingCode.code}${digits}`;
    }

    // 6. E.164 allows 8 to 15 digits after "+".
    if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
      return fail('INVALID_LENGTH');
    }

    // 7. Longest configured calling code, national length, and destination codes.
    const callingCode = this.#callingCodes.find((entry) => digits.startsWith(entry.code));
    if (!callingCode) return fail('UNSUPPORTED_REGION');
    const national = digits.slice(callingCode.code.length);
    if (national.length !== callingCode.nationalNumberLength) return fail('INVALID_LENGTH');
    if (
      callingCode.destinationCodes &&
      !callingCode.destinationCodes.some((destination) => national.startsWith(destination))
    ) {
      return fail('UNSUPPORTED_REGION');
    }

    // 8. Canonical value.
    const value: NormalizedPhone = Object.freeze({
      profile: PHONE_NORMALIZATION_PROFILE,
      canonical: `+${digits}`,
    });
    return { ok: true, value };
  }
}
