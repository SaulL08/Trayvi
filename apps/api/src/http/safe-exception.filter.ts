import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Logger } from '@trayvi/observability';
import { getRequestContext, normalizeInboundId } from '@trayvi/observability';

import { toProblemDetails } from './problem-details';

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = getRequestContext()?.requestId ?? normalizeInboundId(request.id);
    const problem = toProblemDetails(exception, requestId);

    if (!(exception instanceof HttpException) || problem.status >= 500) {
      this.logger.error('http.request.failed', exception, {
        method: request.method,
        route: request.routeOptions?.url ?? 'unmatched',
        statusCode: problem.status,
        outcome: 'failed',
      });
    }

    void reply
      .code(problem.status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send(problem);
  }
}
