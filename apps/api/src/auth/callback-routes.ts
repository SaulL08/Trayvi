import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@trayvi/observability';
import { normalizeInboundId } from '@trayvi/observability';

import { getHttpRequestContext } from '../http/request-context';

import type { AuthServices } from './auth-composition';
import { authProblem, sendAuthProblem } from './auth-problem';

const ALIAS = /^[a-z][a-z0-9-]{0,31}$/u;
const KIND = /^[a-z][a-z-]{0,31}$/u;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * POST /api/v1/provider-callbacks/{providerAlias}/{kind} (PLAN §14). Registered as an encapsulated
 * Fastify plugin whose only body parser keeps raw bytes, so nothing parses the body before the
 * ingress has verified size, signature, and timestamp (R-25). Every rejection is one 401 (R-26).
 */
export function registerCallbackRoutes(
  server: FastifyInstance,
  auth: AuthServices,
  logger: Logger,
): void {
  void server.register((instance, _options, done) => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser(
      '*',
      // Read at most twice the accepted size; the ingress rejects anything above the limit.
      { parseAs: 'buffer', bodyLimit: auth.maxCallbackBodyBytes * 2 },
      (_request, body, parsed) => parsed(null, body),
    );
    instance.post(
      '/api/v1/provider-callbacks/:providerAlias/:kind',
      async (
        request: FastifyRequest<{ Params: { providerAlias: string; kind: string } }>,
        reply: FastifyReply,
      ) => {
        const requestId =
          getHttpRequestContext(request)?.requestId ?? normalizeInboundId(request.id);
        const { providerAlias, kind } = request.params;
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        if (!ALIAS.test(providerAlias) || !KIND.test(kind)) {
          return sendAuthProblem(reply, authProblem('CALLBACK_REJECTED', requestId));
        }
        try {
          const result = await auth.callbacks.receive({
            providerAlias,
            kind,
            timestampHeader: header(request, 'x-trayvi-timestamp'),
            signatureHeader: header(request, 'x-trayvi-signature'),
            rawBody,
            receivedAt: new Date(),
          });
          if (result.kind === 'REJECTED')
            return sendAuthProblem(reply, authProblem('CALLBACK_REJECTED', requestId));
          return reply.code(200).send({});
        } catch (error: unknown) {
          // Handler failure: the receipt rolled back, so the provider's retry is processed again.
          logger.error('auth.callback.failed', error, { outcome: 'failed', requestId });
          return sendAuthProblem(reply, authProblem('REQUEST_CANNOT_BE_COMPLETED', requestId));
        }
      },
    );
    done();
  });
}
