import { HttpStatus } from '@nestjs/common';

export type SafePublicErrorCode =
  | 'INVALID_IDENTITY_DOCUMENT_FORMAT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REQUEST_CANNOT_BE_COMPLETED'
  | 'RATE_LIMITED';

const statusByCode: Readonly<Record<SafePublicErrorCode, number>> = {
  INVALID_IDENTITY_DOCUMENT_FORMAT: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  REQUEST_CANNOT_BE_COMPLETED: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
};

export class SafePublicError extends Error {
  readonly code: SafePublicErrorCode;
  readonly status: number;

  constructor(code: SafePublicErrorCode) {
    super('The request could not be completed.');
    this.name = 'SafePublicError';
    this.code = code;
    this.status = statusByCode[code];
  }
}
