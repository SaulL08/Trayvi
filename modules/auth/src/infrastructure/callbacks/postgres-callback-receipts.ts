import type { SqlExecutor } from '../../contracts/runtime';
import type { CallbackReceiptStore, NewCallbackReceipt } from '../../application/callbacks/ports';

/** auth.provider_callback_receipts (migration 0016); runs on the ingress transaction. */
export class PostgresCallbackReceiptStore implements CallbackReceiptStore {
  async insert(sql: SqlExecutor, receipt: NewCallbackReceipt): Promise<boolean> {
    // ON CONFLICT waits for a concurrent identical callback; if that one commits this is a replay,
    // if it rolls back this one proceeds.
    const result = await sql.query<{ id: string }>(
      `INSERT INTO auth.provider_callback_receipts (id, provider_alias, kind, provider_event_id, received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_alias, kind, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        receipt.id,
        receipt.providerAlias,
        receipt.kind,
        receipt.providerEventId,
        receipt.receivedAt,
      ],
    );
    return result.rows.length === 1;
  }

  async recordOutcome(sql: SqlExecutor, receiptId: string, outcomeCode: string): Promise<void> {
    await sql.query('UPDATE auth.provider_callback_receipts SET outcome_code = $2 WHERE id = $1', [
      receiptId,
      outcomeCode,
    ]);
  }
}
