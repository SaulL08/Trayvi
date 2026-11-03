import type { DeliveryOutcome, DeliveryRequest, OtpDeliveryPort } from '../../contracts/delivery';
import type { RateLimiter } from '../../contracts/rate-limit';
import type { Clock } from '../../contracts/runtime';
import { assertDeliveryRequest } from '../../domain/delivery/delivery-request';

import type { DeliveryTransport } from './ports';

const PROVIDER_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface GuardedDeliveryOptions {
  readonly transport: DeliveryTransport;
  readonly rateLimiter: RateLimiter;
  /** SubjectCommitter.commit('global', 'delivery'): one budget for every send. */
  readonly budgetSubject: Buffer;
  readonly clock: Clock;
  /** Design §5: delivery is awaited at most this long (3 s by default configuration). */
  readonly timeoutMs: number;
}

/**
 * OtpDeliveryPort that spends the global delivery budget before calling the provider and bounds
 * the wait (R-24). Every failure becomes a safe outcome code; no outcome, error, or return value
 * contains the destination or the code (R-23).
 */
export class GuardedOtpDeliveryPort implements OtpDeliveryPort {
  readonly #options: GuardedDeliveryOptions;

  constructor(options: GuardedDeliveryOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new TypeError('DELIVERY_TIMEOUT_INVALID');
    }
    this.#options = options;
  }

  async send(request: DeliveryRequest): Promise<DeliveryOutcome> {
    assertDeliveryRequest(request);
    const budget = await this.#options.rateLimiter.consume(
      'DELIVERY_GLOBAL_MINUTE',
      this.#options.budgetSubject,
      this.#options.clock.now(),
    );
    if (!budget.allowed) return { kind: 'NOT_SENT', safeCode: 'BUDGET_EXHAUSTED' };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => {
        // Settle the race first so the transport's abort rejection cannot win it.
        resolve('TIMEOUT');
        controller.abort();
      }, this.#options.timeoutMs);
    });
    try {
      const result = await Promise.race([
        this.#options.transport.send(request, controller.signal),
        timeout,
      ]);
      if (result === 'TIMEOUT') return { kind: 'NOT_SENT', safeCode: 'TIMEOUT' };
      if (result.kind === 'REJECTED') return { kind: 'NOT_SENT', safeCode: 'PROVIDER_REJECTED' };
      if (!PROVIDER_MESSAGE_ID.test(result.providerMessageId)) {
        return { kind: 'NOT_SENT', safeCode: 'PROVIDER_UNAVAILABLE' };
      }
      return {
        kind: 'SENT',
        providerAlias: this.#options.transport.providerAlias,
        providerMessageId: result.providerMessageId,
      };
    } catch {
      // The provider's error is discarded: it may echo the destination or the message body.
      return { kind: 'NOT_SENT', safeCode: 'PROVIDER_UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
}
