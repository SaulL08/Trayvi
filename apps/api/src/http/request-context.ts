import type { FastifyRequest } from 'fastify';

import type { RequestContext } from '@trayvi/observability';

const contexts = new WeakMap<FastifyRequest, RequestContext>();

export function attachHttpRequestContext(request: FastifyRequest, context: RequestContext): void {
  contexts.set(request, context);
}

export function getHttpRequestContext(request: FastifyRequest): RequestContext | undefined {
  return contexts.get(request);
}
