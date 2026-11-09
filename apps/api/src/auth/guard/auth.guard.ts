import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AuthHttpError } from '../auth-problem';
import { isPublicRoute } from '../public-routes';

/**
 * SPEC-002 scaffold placeholder (design §4 item 3). It allows only the PLAN §9.4 public routes and
 * denies every other route with AUTHENTICATION_REQUIRED, so no route is ever reachable without a
 * principal before ws-d replaces it with the real guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return false;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (isPublicRoute(request.method, request.routeOptions.url)) return true;
    throw new AuthHttpError('AUTHENTICATION_REQUIRED');
  }
}
