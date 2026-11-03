import type { CallbackHandler, CallbackKind } from '../../contracts/callbacks';

export const CALLBACK_KINDS: readonly CallbackKind[] = ['delivery-status', 'reverification'];
export const PROVIDER_ALIAS = /^[a-z][a-z0-9-]{0,31}$/u;
export const PROVIDER_EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
export const OUTCOME_CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;
const TIMESTAMP = /^[0-9]{1,12}$/u;
const SIGNATURE = /^v1=([0-9a-f]{64})$/u;
const MAX_FIELD_STRING = 256;

/** Unix seconds from `X-Trayvi-Timestamp`, or undefined for anything else. */
export function parseTimestampHeader(header: string | undefined): number | undefined {
  return header !== undefined && TIMESTAMP.test(header) ? Number(header) : undefined;
}

/** The 32-byte HMAC from `X-Trayvi-Signature: v1=<hex>`, or undefined. */
export function parseSignatureHeader(header: string | undefined): Buffer | undefined {
  const match = header === undefined ? null : SIGNATURE.exec(header);
  return match?.[1] ? Buffer.from(match[1], 'hex') : undefined;
}

export function isFresh(timestampSeconds: number, now: Date, toleranceSeconds: number): boolean {
  return Math.abs(now.getTime() / 1_000 - timestampSeconds) <= toleranceSeconds;
}

/**
 * R-28: keeps only the handler's allowlisted fields with their declared types. Unknown fields,
 * wrong types, oversized strings, and non-finite numbers are dropped before handle() runs.
 */
export function allowlistedFields(
  body: Readonly<Record<string, unknown>>,
  allowed: CallbackHandler['allowedFields'],
): Readonly<Record<string, string | number | boolean>> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [name, type] of Object.entries(allowed)) {
    if (!Object.hasOwn(body, name)) continue;
    const value = body[name];
    if (type === 'string' && typeof value === 'string' && value.length <= MAX_FIELD_STRING)
      fields[name] = value;
    else if (type === 'number' && typeof value === 'number' && Number.isFinite(value))
      fields[name] = value;
    else if (type === 'boolean' && typeof value === 'boolean') fields[name] = value;
  }
  return Object.freeze(fields);
}

/** Parses an authenticated body: a JSON object with a well-formed providerEventId. */
export function parseCallbackBody(
  rawBody: Buffer,
):
  | { readonly providerEventId: string; readonly body: Readonly<Record<string, unknown>> }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;
  const eventId = body.providerEventId;
  if (typeof eventId !== 'string' || !PROVIDER_EVENT_ID.test(eventId)) return undefined;
  return { providerEventId: eventId, body };
}
