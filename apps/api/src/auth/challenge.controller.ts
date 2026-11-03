import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { networkPrefix, type ClientContext } from '@trayvi/auth';
import { createOpaqueId } from '@trayvi/observability';

import { getHttpRequestContext } from '../http/request-context';

import type { AuthServices } from './auth-composition';
import { AuthExceptionFilter, AuthHttpError } from './auth-problem';
import { AUTH_SERVICES } from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;

/** Strict body: exactly the allowed fields, every required field present (unknown fields rejected). */
function strictBody(
  body: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new AuthHttpError('INVALID_REQUEST');
  const record = body as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in record))
  ) {
    throw new AuthHttpError('INVALID_REQUEST');
  }
  return record;
}

/**
 * SPEC-001 public challenge routes. Only CONTACT_PROOF can start here; SPEC-002 and SPEC-003 open
 * the other purposes on their own authenticated or case-bound routes.
 */
@Controller('api/v1/verification-challenges')
@UseFilters(AuthExceptionFilter)
export class ChallengeController {
  constructor(@Inject(AUTH_SERVICES) private readonly auth: AuthServices) {}

  @Post()
  @HttpCode(202)
  async start(
    @Body() body: unknown,
    @Headers('x-trayvi-installation') installation: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const fields = strictBody(body, ['purpose', 'phoneNumber', 'locale']);
    if (
      fields.purpose !== 'CONTACT_PROOF' ||
      typeof fields.locale !== 'string' ||
      !LOCALE.test(fields.locale)
    ) {
      throw new AuthHttpError('INVALID_REQUEST');
    }
    const result = await this.auth.challenges.start({
      purpose: 'CONTACT_PROOF',
      phoneInput: fields.phoneNumber,
      client: this.#client(installation, request, fields.locale),
    });
    if (result.kind === 'INVALID_CONTACT_FORMAT') {
      // Format does not depend on any account, so the normalization code is safe to expose.
      throw new AuthHttpError('INVALID_CONTACT_FORMAT', {
        errors: [{ field: 'phoneNumber', code: result.code }],
      });
    }
    if (result.kind === 'RATE_LIMITED') {
      throw new AuthHttpError('RATE_LIMITED', { retryAfterSeconds: result.retryAfterSeconds });
    }
    return {
      code: 'CHALLENGE_ACCEPTED',
      challengeId: result.challengeId,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    };
  }

  @Post(':challengeId/resend')
  @HttpCode(202)
  async resend(
    @Param('challengeId') challengeId: string,
    @Body() body: unknown,
    @Headers('x-trayvi-installation') installation: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const fields = strictBody(body, ['phoneNumber']);
    const client = this.#client(installation, request, 'es-DO');
    if (!UUID.test(challengeId)) throw new AuthHttpError('CHALLENGE_NOT_ACTIVE');
    const result = await this.auth.challenges.resend({
      challengeId: challengeId.toLowerCase(),
      phoneInput: fields.phoneNumber,
      client,
    });
    if (result.kind === 'CHALLENGE_NOT_ACTIVE') throw new AuthHttpError('CHALLENGE_NOT_ACTIVE');
    if (result.kind === 'RATE_LIMITED') {
      throw new AuthHttpError('RATE_LIMITED', { retryAfterSeconds: result.retryAfterSeconds });
    }
    return {
      code: 'CHALLENGE_ACCEPTED',
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    };
  }

  @Post(':challengeId/verify')
  @HttpCode(200)
  async verify(
    @Param('challengeId') challengeId: string,
    @Body() body: unknown,
    @Headers('x-trayvi-installation') installation: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const fields = strictBody(body, ['code']);
    const client = this.#client(installation, request, 'es-DO');
    if (!UUID.test(challengeId)) throw new AuthHttpError('CHALLENGE_NOT_ACTIVE');
    const result = await this.auth.challenges.verify({
      challengeId: challengeId.toLowerCase(),
      code: fields.code,
      client,
    });
    if (result.kind === 'VERIFICATION_FAILED') throw new AuthHttpError('VERIFICATION_FAILED');
    if (result.kind === 'CHALLENGE_NOT_ACTIVE') throw new AuthHttpError('CHALLENGE_NOT_ACTIVE');
    if (result.kind === 'RATE_LIMITED') {
      throw new AuthHttpError('RATE_LIMITED', { retryAfterSeconds: result.retryAfterSeconds });
    }
    return {
      proof: result.proofToken,
      proofExpiresAt: result.proofExpiresAt.toISOString(),
      accountExists: result.accountExists,
    };
  }

  #client(
    installation: string | undefined,
    request: FastifyRequest,
    locale: string,
  ): ClientContext {
    if (typeof installation !== 'string' || !UUID.test(installation))
      throw new AuthHttpError('INVALID_REQUEST');
    // Unresolvable addresses share one bucket, so they fail toward the stricter limit.
    const prefix = networkPrefix(request.ip) ?? 'unresolved';
    return {
      installationCommitment: this.auth.subjects.commit('installation', installation.toLowerCase()),
      networkCommitment: this.auth.subjects.commit('network-prefix', prefix),
      correlationId: getHttpRequestContext(request)?.correlationId ?? createOpaqueId(),
      locale,
    };
  }
}
