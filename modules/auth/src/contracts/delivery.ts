import type { NormalizedPhone } from './contact';

export type DeliveryTemplate =
  | 'OTP_CODE'
  | 'SECURITY_NOTICE_NEW_SESSION'
  | 'SECURITY_NOTICE_PASSWORD_CHANGED'
  | 'SECURITY_NOTICE_RECOVERY_STARTED'
  | 'SECURITY_NOTICE_CONTACT_CHANGE_STARTED';

export interface DeliveryRequest {
  readonly destination: NormalizedPhone;
  readonly template: DeliveryTemplate;
  readonly locale: string;
  readonly code?: string; // OTP_CODE only
  readonly reference: string; // opaque UUIDv7 of the challenge or case
}

export type DeliveryNotSentCode =
  'BUDGET_EXHAUSTED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'TIMEOUT';

export type DeliveryOutcome =
  | { readonly kind: 'SENT'; readonly providerAlias: string; readonly providerMessageId: string }
  | { readonly kind: 'NOT_SENT'; readonly safeCode: DeliveryNotSentCode };

export interface OtpDeliveryPort {
  send(request: DeliveryRequest): Promise<DeliveryOutcome>;
}
