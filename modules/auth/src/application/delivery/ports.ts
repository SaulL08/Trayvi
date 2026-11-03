import type { DeliveryRequest } from '../../contracts/delivery';

/** What a provider transport reports; it never echoes the destination or the code. */
export type TransportResult =
  { readonly kind: 'ACCEPTED'; readonly providerMessageId: string } | { readonly kind: 'REJECTED' };

/**
 * Provider transport behind OtpDeliveryPort. It receives the destination and code only in memory
 * and must not log, persist, or return them. Throwing means the provider is unavailable.
 */
export interface DeliveryTransport {
  readonly providerAlias: string;
  send(request: DeliveryRequest, signal: AbortSignal): Promise<TransportResult>;
}
