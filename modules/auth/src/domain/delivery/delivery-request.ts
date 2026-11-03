import type { DeliveryRequest, DeliveryTemplate } from '../../contracts/delivery';

export const DELIVERY_TEMPLATES: readonly DeliveryTemplate[] = [
  'OTP_CODE',
  'SECURITY_NOTICE_NEW_SESSION',
  'SECURITY_NOTICE_PASSWORD_CHANGED',
  'SECURITY_NOTICE_RECOVERY_STARTED',
  'SECURITY_NOTICE_CONTACT_CHANGE_STARTED',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const CANONICAL_PHONE = /^\+[0-9]{8,15}$/u;
const OTP = /^[0-9]{6}$/u;

/** The message never carries the request content, so it is safe to log or return. */
export class DeliveryRequestError extends Error {
  constructor() {
    super('DELIVERY_REQUEST_INVALID');
    this.name = 'DeliveryRequestError';
  }
}

/** A code travels only with OTP_CODE; security notices never carry one. */
export function assertDeliveryRequest(request: DeliveryRequest): void {
  const needsCode = request.template === 'OTP_CODE';
  if (
    !DELIVERY_TEMPLATES.includes(request.template) ||
    request.destination.profile !== 'e164-v1' ||
    !CANONICAL_PHONE.test(request.destination.canonical) ||
    !LOCALE.test(request.locale) ||
    !UUID.test(request.reference) ||
    (needsCode
      ? !(typeof request.code === 'string' && OTP.test(request.code))
      : request.code !== undefined)
  ) {
    throw new DeliveryRequestError();
  }
}
