import { Catch, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@trayvi/observability';
import { normalizeInboundId } from '@trayvi/observability';

import { getHttpRequestContext } from '../http/request-context';

import { AUTH_LOGGER } from './tokens';

/**
 * SPEC-001 and SPEC-002 design §2.3 codes (INVALID_REQUEST is the Foundation code for schema
 * failures). Each route emits only the subset its spec lists.
 */
export type AuthProblemCode =
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHENTICATION_REQUIRED'
  | 'REAUTHENTICATION_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CONTACT_FORMAT'
  | 'VERIFICATION_FAILED'
  | 'CHALLENGE_NOT_ACTIVE'
  | 'RATE_LIMITED'
  | 'CALLBACK_REJECTED'
  | 'REQUEST_CANNOT_BE_COMPLETED';

const STATUS: Readonly<Record<AuthProblemCode, number>> = {
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  AUTHENTICATION_FAILED: HttpStatus.UNAUTHORIZED,
  AUTHENTICATION_REQUIRED: HttpStatus.UNAUTHORIZED,
  REAUTHENTICATION_REQUIRED: HttpStatus.UNAUTHORIZED,
  STEP_UP_REQUIRED: HttpStatus.FORBIDDEN,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  INVALID_CONTACT_FORMAT: HttpStatus.BAD_REQUEST,
  VERIFICATION_FAILED: HttpStatus.BAD_REQUEST,
  CHALLENGE_NOT_ACTIVE: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  CALLBACK_REJECTED: HttpStatus.UNAUTHORIZED,
  REQUEST_CANNOT_BE_COMPLETED: HttpStatus.SERVICE_UNAVAILABLE,
};

const TITLE: Readonly<Record<AuthProblemCode, string>> = {
  INVALID_REQUEST: 'Invalid request',
  AUTHENTICATION_FAILED: 'Authentication failed',
  AUTHENTICATION_REQUIRED: 'Authentication required',
  REAUTHENTICATION_REQUIRED: 'Reauthentication required',
  STEP_UP_REQUIRED: 'Step-up required',
  IDEMPOTENCY_CONFLICT: 'Idempotency conflict',
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

/** SPEC-002 design §2.3: what a `STEP_UP_REQUIRED` answer tells the client to satisfy. */
export interface AuthStepUpDetails {
  readonly requiredAssurance: 'AAL1' | 'AAL2';
  readonly maxAgeSeconds: number;
}

export interface AuthProblemDetails {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly code: AuthProblemCode;
  readonly requestId: string;
  readonly errors?: readonly AuthFieldError[];
  readonly requiredAssurance?: AuthStepUpDetails['requiredAssurance'];
  readonly maxAgeSeconds?: number;
}

export class AuthHttpError extends Error {
  readonly code: AuthProblemCode;
  readonly retryAfterSeconds: number | undefined;
  readonly errors: readonly AuthFieldError[] | undefined;
  readonly stepUp: AuthStepUpDetails | undefined;

  constructor(
    code: AuthProblemCode,
    options: {
      readonly retryAfterSeconds?: number;
      readonly errors?: readonly AuthFieldError[];
      readonly stepUp?: AuthStepUpDetails;
    } = {},
  ) {
    super(code);
    this.name = 'AuthHttpError';
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.errors = options.errors;
    this.stepUp = options.stepUp;
  }
}

export function authProblem(
  code: AuthProblemCode,
  requestId: string,
  errors?: readonly AuthFieldError[],
  stepUp?: AuthStepUpDetails,
): AuthProblemDetails {
  return {
    type: 'about:blank',
    title: TITLE[code],
    status: STATUS[code],
    code,
    requestId,
    ...(errors ? { errors } : {}),
    ...(stepUp && code === 'STEP_UP_REQUIRED' ? stepUp : {}),
  };
}

/** Sends an AuthHttpError as Problem Details. Shared by the Auth and global exception filters. */
export function sendAuthHttpError(
  reply: FastifyReply,
  error: AuthHttpError,
  requestId: string,
): FastifyReply {
  return sendAuthProblem(
    reply,
    authProblem(error.code, requestId, error.errors, error.stepUp),
    error.retryAfterSeconds,
  );
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
      void sendAuthHttpError(reply, exception, requestId);
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
