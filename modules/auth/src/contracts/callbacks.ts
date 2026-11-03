import type { SqlExecutor } from './runtime';

export type CallbackKind = 'delivery-status' | 'reverification';

export interface VerifiedCallback {
  readonly providerAlias: string;
  readonly kind: CallbackKind;
  readonly providerEventId: string; // ^[A-Za-z0-9._:-]{1,128}$
  readonly receivedAt: Date;
  readonly fields: Readonly<Record<string, string | number | boolean>>; // allowlisted per kind
}

export interface CallbackHandler {
  readonly kind: CallbackKind;
  /** Field allowlist and types. Unknown fields are dropped before handle(). */
  readonly allowedFields: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
  handle(sql: SqlExecutor, callback: VerifiedCallback): Promise<{ readonly outcomeCode: string }>;
}

/** REJECTED is the single public shape for every authentication failure. */
export type CallbackIngressResult =
  { readonly kind: 'ACCEPTED' } | { readonly kind: 'DUPLICATE' } | { readonly kind: 'REJECTED' };

export interface CallbackIngress {
  receive(input: {
    readonly providerAlias: string;
    readonly kind: string;
    readonly timestampHeader: string | undefined;
    readonly signatureHeader: string | undefined;
    readonly rawBody: Buffer;
    readonly receivedAt: Date;
  }): Promise<CallbackIngressResult>;
}
