import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@trayvi/observability';

import { AuthHttpError } from '../../src/auth/auth-problem';
import { AuthGuard } from '../../src/auth/guard';
import { PUBLIC_ROUTES, isPublicRoute } from '../../src/auth/public-routes';
import { SafeExceptionFilter } from '../../src/http/safe-exception.filter';

function httpContext(method: string, url: string | undefined): ExecutionContext {
  const request = { method, routeOptions: { url } };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function denial(method: string, url: string | undefined): unknown {
  try {
    new AuthGuard().canActivate(httpContext(method, url));
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('SPEC-002 public-route allowlist (PLAN §9.4)', () => {
  it('freezes exactly the PLAN §9.4 public routes', () => {
    expect(Object.isFrozen(PUBLIC_ROUTES)).toBe(true);
    expect(PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /health/live',
      'GET /health/ready',
      'POST /api/v1/verification-challenges',
      'POST /api/v1/verification-challenges/{id}/resend',
      'POST /api/v1/verification-challenges/{id}/verify',
      'POST /api/v1/provider-callbacks/{providerAlias}/{kind}',
      'POST /api/v1/account-registrations',
      'POST /api/v1/account-registrations/{id}/identity',
      'POST /api/v1/sessions',
      'POST /api/v1/sessions/refresh',
      'POST /api/v1/recovery-cases',
      'POST /api/v1/recovery-cases/cancel-challenges',
      'POST /api/v1/recovery-cases/cancel',
    ]);
  });

  it('matches Fastify parameter templates whatever the parameter is called', () => {
    expect(isPublicRoute('POST', '/api/v1/verification-challenges/:challengeId/verify')).toBe(true);
    expect(isPublicRoute('post', '/api/v1/sessions/')).toBe(true);
    expect(isPublicRoute('HEAD', '/health/live')).toBe(true);
  });

  it('does not match other methods, extra segments, or unknown templates', () => {
    expect(isPublicRoute('GET', '/api/v1/sessions')).toBe(false);
    expect(isPublicRoute('DELETE', '/api/v1/sessions/current')).toBe(false);
    expect(isPublicRoute('POST', '/api/v1/sessions/current/step-up')).toBe(false);
    expect(isPublicRoute('POST', '/api/v1/verification-challenges/:id/verify/extra')).toBe(false);
    expect(isPublicRoute('GET', '/api/v1/accounts/me')).toBe(false);
    expect(isPublicRoute('GET', undefined)).toBe(false);
  });
});

describe('SPEC-002 placeholder guard', () => {
  it('lets public routes through', () => {
    expect(new AuthGuard().canActivate(httpContext('GET', '/health/ready'))).toBe(true);
    expect(
      new AuthGuard().canActivate(httpContext('POST', '/api/v1/verification-challenges')),
    ).toBe(true);
  });

  it('denies every other route with AUTHENTICATION_REQUIRED', () => {
    for (const [method, url] of [
      ['GET', '/api/v1/sessions'],
      ['DELETE', '/api/v1/sessions/:familyId'],
      ['PUT', '/api/v1/credentials/password'],
      ['GET', '/api/v1/accounts/me'],
      ['GET', '/api/v1/future'],
      ['GET', undefined],
    ] as const) {
      const error = denial(method, url);
      expect(error).toBeInstanceOf(AuthHttpError);
      expect((error as AuthHttpError).code).toBe('AUTHENTICATION_REQUIRED');
    }
  });

  it('denies non-HTTP execution contexts', () => {
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(new AuthGuard().canActivate(context)).toBe(false);
  });
});

describe('global exception filter with Auth errors', () => {
  function render(error: unknown): { status: unknown; body: unknown } {
    const sent: unknown[] = [];
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn((value: unknown) => sent.push(value)),
    };
    const request = {
      id: '018f4f7a-3c2b-7b11-8abc-0123456789ab',
      method: 'GET',
      routeOptions: { url: '/api/v1/accounts/me' },
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    new SafeExceptionFilter(logger).catch(error, host);
    expect(logger.error).not.toHaveBeenCalled();
    return { status: reply.code.mock.calls[0]?.[0], body: sent[0] };
  }

  it('renders a guard denial as a 401 AUTHENTICATION_REQUIRED problem', () => {
    expect(render(new AuthHttpError('AUTHENTICATION_REQUIRED'))).toEqual({
      status: 401,
      body: {
        type: 'about:blank',
        title: 'Authentication required',
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        requestId: '018f4f7a-3c2b-7b11-8abc-0123456789ab',
      },
    });
  });

  it('adds the required assurance and maximum age to STEP_UP_REQUIRED only', () => {
    const stepUp = { requiredAssurance: 'AAL1', maxAgeSeconds: 300 } as const;
    expect(render(new AuthHttpError('STEP_UP_REQUIRED', { stepUp })).body).toMatchObject({
      status: 403,
      code: 'STEP_UP_REQUIRED',
      requiredAssurance: 'AAL1',
      maxAgeSeconds: 300,
    });
    expect(render(new AuthHttpError('AUTHENTICATION_FAILED', { stepUp })).body).not.toHaveProperty(
      'requiredAssurance',
    );
  });
});
