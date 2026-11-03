import { randomUUID } from 'node:crypto';

import type { DeliveryRequest } from '../../contracts/delivery';
import type { DeliveryTransport, TransportResult } from '../../application/delivery/ports';

export interface SyntheticMessage {
  readonly providerMessageId: string;
  readonly request: DeliveryRequest;
}

export type SyntheticBehavior = 'ACCEPT' | 'REJECT' | 'FAIL' | 'HANG';

/**
 * Phase 2 synthetic provider (no real SMS/WhatsApp; production blocker P2-AC-039). Messages stay in
 * an in-memory outbox that tests read; nothing is logged or persisted.
 */
export class SyntheticDeliveryTransport implements DeliveryTransport {
  readonly providerAlias = 'synthetic';
  readonly #outbox: SyntheticMessage[] = [];
  behavior: SyntheticBehavior = 'ACCEPT';

  send(request: DeliveryRequest, signal: AbortSignal): Promise<TransportResult> {
    if (this.behavior === 'FAIL')
      return Promise.reject(new Error('synthetic provider unavailable'));
    if (this.behavior === 'REJECT') return Promise.resolve({ kind: 'REJECTED' });
    if (this.behavior === 'HANG') {
      return new Promise<TransportResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const providerMessageId = `syn-${randomUUID()}`;
    this.#outbox.push(Object.freeze({ providerMessageId, request: Object.freeze({ ...request }) }));
    return Promise.resolve({ kind: 'ACCEPTED', providerMessageId });
  }

  /** Test-only view of what was "sent". */
  messages(): readonly SyntheticMessage[] {
    return [...this.#outbox];
  }

  clear(): void {
    this.#outbox.length = 0;
  }

  toJSON(): string {
    return '[SyntheticDeliveryTransport]';
  }
}
