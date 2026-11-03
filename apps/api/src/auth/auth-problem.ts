import { Catch, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@trayvi/observability';
import { normalizeInboundId } from '@trayvi/observability';

import { getHttpRequestContext } from '../http/request-context';

import { AUTH_LOGGER } from './tokens';

/** SPEC-001 design §2.3 codes, plus INVALID_REQUEST for requests that fail the strict schema. */
export type AuthProblemCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CONTACT_FORMAT'
  | 'VERIFICATION_FAILED'
  | 'CHALLENGE_NOT_ACTIVE'
  | 'RATE_LIMITED'
  | 'CALLBACK_REJECTED'
  | 'REQUEST_CANNOT_BE_COMPLETED';

const STATUS: Readonly<Record<AuthProblemCode, number>> = {
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  INVALID_CONTACT_FORMAT: HttpStatus.BAD_REQUEST,
  VERIFICATION_FAILED: HttpStatus.BAD_REQUEST,
  CHALLENGE_NOT_ACTIVE: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  CALLBACK_REJECTED: HttpStatus.UNAUTHORIZED,
  REQUEST_CANNOT_BE_COMPLETED: HttpStatus.SERVICE_UNAVAILABLE,
};

const TITLE: Readonly<Record<AuthProblemCode, string>> = {
  INVALID_REQUEST: 'Invalid request',
  INVALID_CONTACT_FORMAT: 'Invalid contact format',
  VERIFICATION_FAILED: 'Verification failed',
  CHALLENGE_NOT_ACTIVE: 'Challenge not active',
  RATE_LIMITED: 'Too many requests',
  CALLBACK_REJECTED: 'Callback rejected',
  REQUEST_CANNOT_BE_COMPLETED: 'Request cannot be completed',
};

export interface AuthFieldError {
  readonly field: string;
  readonly code: string;
}

export interface AuthProblemDetails {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly code: AuthProblemCode;
  readonly requestId: string;
  readonly errors?: readonly AuthFieldError[];
}

export class AuthHttpError extends Error {
  readonly code: AuthProblemCode;
  readonly retryAfterSeconds: number | undefined;
  readonly errors: readonly AuthFieldError[] | undefined;

  constructor(
    code: AuthProblemCode,
    options: {
      readonly retryAfterSeconds?: number;
      readonly errors?: readonly AuthFieldError[];
    } = {},
  ) {
    super(code);
    this.name = 'AuthHttpError';
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.errors = options.errors;
  }
}

export function authProblem(
  code: AuthProblemCode,
  requestId: string,
  errors?: readonly AuthFieldError[],
): AuthProblemDetails {
  return {
    type: 'about:blank',
    title: TITLE[code],
    status: STATUS[code],
    code,
    requestId,
    ...(errors ? { errors } : {}),
  };
}

export function sendAuthProblem(
  reply: FastifyReply,
  problem: AuthProblemDetails,
  retryAfterSeconds?: number,
): FastifyReply {
  if (retryAfterSeconds !== undefined)
    reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return reply
    .code(problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(problem);
}

/** R-32: Auth routes answer only the codes above; anything unexpected is a safe 503. */
@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  constructor(@Inject(AUTH_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = getHttpRequestContext(request)?.requestId ?? normalizeInboundId(request.id);
    if (exception instanceof AuthHttpError) {
      void sendAuthProblem(
        reply,
        authProblem(exception.code, requestId, exception.errors),
        exception.retryAfterSeconds,
      );
      return;
    }
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      void sendAuthProblem(reply, authProblem('INVALID_REQUEST', requestId));
      return;
    }
    this.logger.error('auth.request.failed', exception, {
      route: request.routeOptions?.url ?? 'unmatched',
      outcome: 'failed',
      requestId,
    });
    void sendAuthProblem(reply, authProblem('REQUEST_CANNOT_BE_COMPLETED', requestId));
  }
}
