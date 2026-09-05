import { AsyncLocalStorage } from 'node:async_hooks';

import { context as otelContext, trace } from '@opentelemetry/api';
import { v7 as uuidv7, validate as validateUuid } from 'uuid';

export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly traceId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createOpaqueId(): string {
  return uuidv7();
}

export function normalizeInboundId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !validateUuid(value)) {
    return createOpaqueId();
  }
  return value.toLowerCase();
}

export function createRequestContext(requestId: unknown, correlationId: unknown): RequestContext {
  const effectiveRequestId = normalizeInboundId(requestId);
  const activeSpan = trace.getSpan(otelContext.active());
  const traceId = activeSpan?.spanContext().traceId;

  return {
    requestId: effectiveRequestId,
    correlationId: normalizeInboundId(correlationId ?? effectiveRequestId),
    ...(traceId ? { traceId } : {}),
  };
}

export function runWithRequestContext<T>(requestContext: RequestContext, callback: () => T): T {
  return storage.run(requestContext, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
