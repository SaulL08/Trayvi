const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
const MAX_STRING_LENGTH = 4_096;

const sensitiveKeyNames = [
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'password',
  'passcode',
  'pin',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'session_token',
  'secret',
  'client_secret',
  'api_key',
  'documents',
  'document_number',
  'national_id',
  'cedula',
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
    normalized.endsWith('apikey')
  );
}

function sanitizeString(input: string): string {
  let value = input.slice(0, MAX_STRING_LENGTH);
  if (input.length > MAX_STRING_LENGTH) {
    value += TRUNCATED;
  }

  value = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  }).join('');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  value = value.replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED);
  value = value.replace(/\b(?:postgres(?:ql)?):\/\/[^\s]+/giu, '[REDACTED_DATABASE_URL]');
  value = value.replace(/([?&][^=\s&#]{1,128}=)[^\s&#]*/gu, `$1${REDACTED}`);
  value = value.replace(sensitiveDoubleQuotedAssignment, `$<prefix>"${REDACTED}"`);
  value = value.replace(sensitiveSingleQuotedAssignment, `$<prefix>'${REDACTED}'`);
  value = value.replace(sensitiveBareAssignment, `$<prefix>${REDACTED}`);
  return value;
}

function sanitizeError(error: Error, seen: WeakSet<object>, depth: number): SafeLogValue {
  const cause = 'cause' in error ? error.cause : undefined;
  return {
    name: sanitizeString(error.name),
    message: sanitizeString(error.message),
    ...(error.stack ? { stack: sanitizeString(error.stack) } : {}),
    ...(cause === undefined ? {} : { cause: sanitizeValue(cause, seen, depth + 1) }),
  };
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
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return sanitizeError(value, seen, depth);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return sanitizeString(value.toString());
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ENTRIES).map((item) => sanitizeValue(item, seen, depth + 1));
    if (value.length > MAX_ENTRIES) {
      result.push(TRUNCATED);
    }
    return result;
  }

  const output: Record<string, SafeLogValue> = {};
  const entries = Object.entries(value).slice(0, MAX_ENTRIES);
  for (const [key, child] of entries) {
    output[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(child, seen, depth + 1);
  }
  if (Object.keys(value).length > MAX_ENTRIES) {
    output._truncated = true;
  }
  return output;
}

export function sanitizeForLogging(value: unknown): SafeLogValue {
  return sanitizeValue(value, new WeakSet<object>(), 0);
}

export function sanitizeLogRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, SafeLogValue> {
  const sanitized = sanitizeForLogging(value);
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? { ...(sanitized as Readonly<Record<string, SafeLogValue>>) }
    : { value: sanitized };
}
