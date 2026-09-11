import { HttpException, HttpStatus } from '@nestjs/common';

import { SafePublicError } from './safe-public-error';

export interface ProblemDetails {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
}

const titleByStatus: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Invalid request',
  [HttpStatus.CONFLICT]: 'Request cannot be completed',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
  [HttpStatus.NOT_FOUND]: 'Resource not found',
  [HttpStatus.REQUEST_TIMEOUT]: 'Request timed out',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload too large',
  [HttpStatus.URI_TOO_LONG]: 'Request URI too long',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service unavailable',
};

const codeByStatus: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_REQUEST',
  [HttpStatus.CONFLICT]: 'REQUEST_CANNOT_BE_COMPLETED',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.URI_TOO_LONG]: 'REQUEST_URI_TOO_LONG',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

export function toProblemDetails(exception: unknown, requestId: string): ProblemDetails {
  const fastifyCode =
    typeof exception === 'object' && exception !== null && 'code' in exception
      ? String(exception.code)
      : undefined;
  const status =
    exception instanceof SafePublicError
      ? exception.status
      : fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
  const safeStatus = status >= 400 && status <= 599 ? status : HttpStatus.INTERNAL_SERVER_ERROR;

  return {
    type: 'about:blank',
    title: titleByStatus[safeStatus] ?? 'Request failed',
    status: safeStatus,
    code:
      exception instanceof SafePublicError
        ? exception.code
        : (codeByStatus[safeStatus] ?? 'REQUEST_FAILED'),
    requestId,
  };
}
