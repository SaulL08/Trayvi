import type { CallbackHandler, VerifiedCallback } from '../../contracts/callbacks';
import type { SqlExecutor } from '../../contracts/runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OUTCOMES = new Set([
  'RECORDED_DELIVERED',
  'RECORDED_UNDELIVERED',
  'UNKNOWN_REFERENCE',
  'IGNORED_NOT_SENT',
  'IGNORED_INVALID_STATUS',
]);

/**
 * T-D3 delivery-status handler. The provider reports on the message it sent for a challenge; the
 * reference is the challenge ID passed in DeliveryRequest.reference. The status is recorded only
 * through auth.record_challenge_delivery_status (migration 0016).
 */
export class DeliveryStatusCallbackHandler implements CallbackHandler {
  readonly kind = 'delivery-status' as const;
  readonly allowedFields = { reference: 'string', status: 'string' } as const;

  async handle(
    sql: SqlExecutor,
    callback: VerifiedCallback,
  ): Promise<{ readonly outcomeCode: string }> {
    const reference = callback.fields.reference;
    const status = callback.fields.status;
    if (typeof reference !== 'string' || !UUID.test(reference)) {
      return { outcomeCode: 'IGNORED_INVALID_REFERENCE' };
    }
    const result = await sql.query<{ outcome: string }>(
      'SELECT auth.record_challenge_delivery_status($1, $2, $3) AS outcome',
      [reference, typeof status === 'string' ? status : '', callback.receivedAt],
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome === undefined || !OUTCOMES.has(outcome))
      throw new Error('DELIVERY_STATUS_OUTCOME_INVALID');
    return { outcomeCode: outcome };
  }
}
