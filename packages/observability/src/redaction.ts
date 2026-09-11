const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const ACCESSOR = '[ACCESSOR]';
const UNSANITIZABLE = '[UNSANITIZABLE]';
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
const MAX_STRING_LENGTH = 4_096;
const MAX_PERCENT_DECODE_PASSES = 2;

const sensitiveKeyNames = [
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'password',
  'passwd',
  'passcode',
  'pin',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'session_token',
  'session',
  'session_id',
  'secret',
  'secret_key',
  'credential',
  'credentials',
  'client_secret',
  'api_key',
  'private_key',
  'ssl_key',
  'database_url',
  'connection_string',
  'documents',
  'identity_document',
  'document_value',
  'normalized_document',
  'canonical_document',
  'document_number',
  'national_id',
  'cedula',
  'fingerprint',
  'fingerprint_claim',
  'hmac',
  'ciphertext',
  'wrapped_dek',
  'authentication_tag',
  'encryption_tag',
  'nonce',
  'kek_key_version',
  'hmac_key_version',
  'idempotency_key',
  'request_commitment',
  'caller_binding',
  'card',
  'card_number',
  'pan',
  'cvv',
  'cvc',
  'payment_credential',
  'payment_credentials',
  'bank_account',
  'routing_number',
  'biometric',
  'biometrics',
  'latitude',
  'longitude',
  'coordinates',
  'precise_location',
] as const;

const sensitiveKeys = new Set(sensitiveKeyNames.map((key) => key.replaceAll('_', '')));
const sensitiveTextKeyPattern = [...sensitiveKeyNames]
  .sort((left, right) => right.length - left.length)
  .map((key) => key.split('_').join('[_\\s-]*'))
  .join('|');
const assignmentPrefix = `(?<prefix>(?:^|[?&,;\\s{])['"]?(?:${sensitiveTextKeyPattern})['"]?\\s*[:=]\\s*)`;
const sensitiveDoubleQuotedAssignment = new RegExp(
  `${assignmentPrefix}"(?:\\\\.|[^"\\\\])*"`,
  'giu',
);
const sensitiveSingleQuotedAssignment = new RegExp(
  `${assignmentPrefix}'(?:\\\\.|[^'\\\\])*'`,
  'giu',
);
const sensitiveBareAssignment = new RegExp(`${assignmentPrefix}(?!["'\\[])[^\\s,;&}\\]]+`, 'giu');
const privateKeyBlock =
  /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/giu;

export type SafeLogValue =
  | null
  | boolean
  | number
  | string
  | readonly SafeLogValue[]
  | { readonly [key: string]: SafeLogValue };

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('fingerprint') ||
    normalized.endsWith('ciphertext') ||
    normalized.endsWith('wrappeddek') ||
    normalized.endsWith('commitment') ||
    normalized.endsWith('apikey')
  );
}

function sanitizeString(input: string): string {
  let value = input.slice(0, MAX_STRING_LENGTH);
  if (input.length > MAX_STRING_LENGTH) {
    value += TRUNCATED;
  }

  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = value.replace(/%([0-9a-f]{2})/giu, (_, hexadecimal: string) =>
        String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
      );
    }
    if (decoded === value) break;
    value = decoded.slice(0, MAX_STRING_LENGTH);
  }

  value = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  }).join('');
  value = value.replace(privateKeyBlock, '[REDACTED_PRIVATE_KEY]');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  value = value.replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED);
  value = value.replace(/\b(?:postgres(?:ql)?):\/\/[^\s]+/giu, '[REDACTED_DATABASE_URL]');
  value = value.replace(/([?&][^=\s&#]{1,128}=)[^\s&#]*/gu, `$1${REDACTED}`);
  value = value.replace(sensitiveDoubleQuotedAssignment, `$<prefix>"${REDACTED}"`);
  value = value.replace(sensitiveSingleQuotedAssignment, `$<prefix>'${REDACTED}'`);
  value = value.replace(sensitiveBareAssignment, `$<prefix>${REDACTED}`);
  return value;
}

function descriptorsOf(value: object): PropertyDescriptorMap | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor && 'value' in descriptor ? descriptor.value : ACCESSOR;
}

function sanitizeError(
  descriptors: PropertyDescriptorMap,
  seen: WeakSet<object>,
  depth: number,
): SafeLogValue {
  const output: Record<string, SafeLogValue> = {};
  const name = descriptorValue(descriptors.name);
  const message = descriptorValue(descriptors.message);
  const stack = descriptorValue(descriptors.stack);
  const cause = descriptorValue(descriptors.cause);
  const aggregateErrors = descriptorValue(descriptors.errors);
  output.name = typeof name === 'string' ? sanitizeString(name) : 'Error';
  output.message =
    typeof message === 'string'
      ? sanitizeString(message)
      : message === ACCESSOR
        ? ACCESSOR
        : '[NON_STRING_ERROR_MESSAGE]';
  if (stack !== ACCESSOR && stack !== undefined)
    output.stack = sanitizeValue(stack, seen, depth + 1);
  else if (descriptors.stack) output.stack = ACCESSOR;
  if (cause !== ACCESSOR && cause !== undefined)
    output.cause = sanitizeValue(cause, seen, depth + 1);
  else if (descriptors.cause) output.cause = ACCESSOR;
  if (aggregateErrors !== ACCESSOR && aggregateErrors !== undefined)
    output.errors = sanitizeValue(aggregateErrors, seen, depth + 1);
  else if (descriptors.errors) output.errors = ACCESSOR;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (['name', 'message', 'stack', 'cause', 'errors'].includes(key) || !descriptor.enumerable)
      continue;
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : 'value' in descriptor
        ? sanitizeValue(descriptor.value, seen, depth + 1)
        : ACCESSOR;
  }
  return output;
}

function sanitizeArray(
  descriptors: PropertyDescriptorMap,
  seen: WeakSet<object>,
  depth: number,
): SafeLogValue[] {
  const lengthValue = descriptorValue(descriptors.length);
  const length =
    typeof lengthValue === 'number' && Number.isSafeInteger(lengthValue) ? lengthValue : 0;
  const result: SafeLogValue[] = [];
  for (let index = 0; index < Math.min(length, MAX_ENTRIES); index += 1) {
    const descriptor = descriptors[String(index)];
    result.push(
      descriptor && 'value' in descriptor
        ? sanitizeValue(descriptor.value, seen, depth + 1)
        : descriptor
          ? ACCESSOR
          : '[EMPTY]',
    );
  }
  if (length > MAX_ENTRIES) result.push(TRUNCATED);
  return result;
}

function sanitizeObject(
  descriptors: PropertyDescriptorMap,
  seen: WeakSet<object>,
  depth: number,
): SafeLogValue {
  const output: Record<string, SafeLogValue> = {};
  const entries = Object.entries(descriptors)
    .filter(([, descriptor]) => descriptor.enumerable === true)
    .slice(0, MAX_ENTRIES);
  for (const [key, descriptor] of entries) {
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : 'value' in descriptor
        ? sanitizeValue(descriptor.value, seen, depth + 1)
        : ACCESSOR;
  }
  const enumerableCount = Object.values(descriptors).filter(
    (descriptor) => descriptor.enumerable === true,
  ).length;
  if (enumerableCount > MAX_ENTRIES) output._truncated = true;
  return output;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): SafeLogValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (value === undefined) {
    return '[UNDEFINED]';
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return `[${typeof value}]`;
  }
  if (depth > MAX_DEPTH) {
    return '[MAX_DEPTH]';
  }
  try {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const descriptors = descriptorsOf(value);
    if (!descriptors) return UNSANITIZABLE;

    if (value instanceof Error) return sanitizeError(descriptors, seen, depth);
    if (value instanceof Date) return sanitizeString(Date.prototype.toISOString.call(value));
    if (value instanceof URL) return sanitizeString(URL.prototype.toString.call(value));
    if (Array.isArray(value)) return sanitizeArray(descriptors, seen, depth);
    return sanitizeObject(descriptors, seen, depth);
  } catch {
    return UNSANITIZABLE;
  }
}

export function sanitizeForLogging(value: unknown): SafeLogValue {
  try {
    return sanitizeValue(value, new WeakSet<object>(), 0);
  } catch {
    return UNSANITIZABLE;
  }
}

export function sanitizeLogRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, SafeLogValue> {
  const sanitized = sanitizeForLogging(value);
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? { ...(sanitized as Readonly<Record<string, SafeLogValue>>) }
    : { value: sanitized };
}
