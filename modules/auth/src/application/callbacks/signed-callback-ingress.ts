import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  CallbackHandler,
  CallbackIngress,
  CallbackIngressResult,
  CallbackKind,
  VerifiedCallback,
} from '../../contracts/callbacks';
import type { IdGenerator, TransactionRunner } from '../../contracts/runtime';
import {
  allowlistedFields,
  CALLBACK_KINDS,
  isFresh,
  OUTCOME_CODE,
  parseCallbackBody,
  parseSignatureHeader,
  parseTimestampHeader,
  PROVIDER_ALIAS,
} from '../../domain/callbacks/callback-format';

import type { CallbackProvider, CallbackReceiptStore } from './ports';

const REJECTED: CallbackIngressResult = { kind: 'REJECTED' };
// Unknown aliases still compute one HMAC so their timing matches a known alias with a bad signature.
const DECOY_SECRET = Buffer.alloc(32, 0);

export interface SignedCallbackIngressOptions {
  readonly transactions: TransactionRunner;
  readonly providers: readonly CallbackProvider[];
  readonly handlers: readonly CallbackHandler[];
  readonly receipts: CallbackReceiptStore;
  readonly ids: IdGenerator;
  /** PLAN §14: 16 KiB. */
  readonly maxBodyBytes: number;
  /** PLAN §14: 300 seconds. */
  readonly timestampToleranceSeconds: number;
}

export class CallbackOutcomeError extends Error {
  constructor() {
    super('CALLBACK_OUTCOME_INVALID');
    this.name = 'CallbackOutcomeError';
  }
}

/**
 * ws-d CallbackIngress (R-25 to R-28). Size, signature, and timestamp are verified before the body
 * is parsed; every authentication failure returns the same REJECTED result. A receipt unique on
 * (alias, kind, event) makes replays a no-op, and the receipt commits only with the handler's
 * effect, so a handler failure lets the provider's retry be processed again.
 */
export class SignedCallbackIngress implements CallbackIngress {
  readonly #options: SignedCallbackIngressOptions;
  readonly #providers: ReadonlyMap<string, Buffer>;
  readonly #handlers: ReadonlyMap<string, CallbackHandler>;

  constructor(options: SignedCallbackIngressOptions) {
    const providers = new Map<string, Buffer>();
    for (const provider of options.providers) {
      if (
        !PROVIDER_ALIAS.test(provider.alias) ||
        providers.has(provider.alias) ||
        provider.secret.byteLength < 32
      ) {
        throw new TypeError('CALLBACK_PROVIDER_INVALID');
      }
      providers.set(provider.alias, Buffer.from(provider.secret));
    }
    const handlers = new Map<string, CallbackHandler>();
    for (const handler of options.handlers) {
      if (!CALLBACK_KINDS.includes(handler.kind) || handlers.has(handler.kind)) {
        throw new TypeError('CALLBACK_HANDLER_INVALID');
      }
      handlers.set(handler.kind, handler);
    }
    this.#options = options;
    this.#providers = providers;
    this.#handlers = handlers;
  }

  async receive(input: Parameters<CallbackIngress['receive']>[0]): Promise<CallbackIngressResult> {
    // 1. Size first: an oversized body is never hashed or parsed.
    if (input.rawBody.byteLength > this.#options.maxBodyBytes) return REJECTED;

    // 2. Signature and timestamp, with the same work for every failure.
    const secret = this.#providers.get(input.providerAlias);
    const timestamp = parseTimestampHeader(input.timestampHeader);
    const signature = parseSignatureHeader(input.signatureHeader);
    const expected = createHmac('sha256', secret ?? DECOY_SECRET)
      .update(input.timestampHeader ?? '', 'utf8')
      .update('.', 'utf8')
      .update(input.rawBody)
      .digest();
    const signatureValid =
      signature !== undefined &&
      signature.byteLength === expected.byteLength &&
      timingSafeEqual(signature, expected);
    const fresh =
      timestamp !== undefined &&
      isFresh(timestamp, input.receivedAt, this.#options.timestampToleranceSeconds);
    const handler = this.#handlers.get(input.kind);
    if (secret === undefined || !signatureValid || !fresh || handler === undefined) return REJECTED;

    // 3. Only an authenticated, fresh body is parsed, and only allowlisted fields survive.
    const parsed = parseCallbackBody(input.rawBody);
    if (!parsed) return REJECTED;
    const callback: VerifiedCallback = {
      providerAlias: input.providerAlias,
      kind: input.kind as CallbackKind,
      providerEventId: parsed.providerEventId,
      receivedAt: input.receivedAt,
      fields: allowlistedFields(parsed.body, handler.allowedFields),
    };

    // 4. Receipt and effect commit together.
    return this.#options.transactions.inTransaction(async (sql) => {
      const receiptId = this.#options.ids.uuidV7();
      const inserted = await this.#options.receipts.insert(sql, {
        id: receiptId,
        providerAlias: callback.providerAlias,
        kind: callback.kind,
        providerEventId: callback.providerEventId,
        receivedAt: callback.receivedAt,
      });
      if (!inserted) return { kind: 'DUPLICATE' } as const;
      const { outcomeCode } = await handler.handle(sql, callback);
      if (!OUTCOME_CODE.test(outcomeCode)) throw new CallbackOutcomeError();
      await this.#options.receipts.recordOutcome(sql, receiptId, outcomeCode);
      return { kind: 'ACCEPTED' } as const;
    });
  }
}
