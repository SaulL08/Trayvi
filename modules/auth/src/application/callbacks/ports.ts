import type { CallbackKind } from '../../contracts/callbacks';
import type { SqlExecutor } from '../../contracts/runtime';

export interface NewCallbackReceipt {
  readonly id: string;
  readonly providerAlias: string;
  readonly kind: CallbackKind;
  readonly providerEventId: string;
  readonly receivedAt: Date;
}

export interface CallbackReceiptStore {
  /** False when the (alias, kind, event) receipt already exists: a replay. */
  insert(sql: SqlExecutor, receipt: NewCallbackReceipt): Promise<boolean>;
  recordOutcome(sql: SqlExecutor, receiptId: string, outcomeCode: string): Promise<void>;
}

export interface CallbackProvider {
  readonly alias: string;
  /** HMAC-SHA-256 signing secret; never logged. */
  readonly secret: Buffer;
}
