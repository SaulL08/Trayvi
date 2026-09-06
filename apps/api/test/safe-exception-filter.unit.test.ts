import { PassThrough } from 'node:stream';

import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@trayvi/observability';
import { StructuredLogger } from '@trayvi/observability';

import { SafeExceptionFilter } from '../src/http/safe-exception.filter';

describe('safe exception filter', () => {
  it('sends only the stable envelope when an unexpected failure contains internal data', () => {
    const sent: unknown[] = [];
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn((value: unknown) => sent.push(value)),
    };
    const request = {
      id: '018f4f7a-3c2b-7b11-8abc-0123456789ab',
      method: 'GET',
      routeOptions: { url: '/api/v1/future' },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const filter = new SafeExceptionFilter(logger);
    const canary = 'postgresql://user:password@db.internal/trayvi C:\\private\\query.sql';

    filter.catch(new Error(canary), host);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.header).toHaveBeenCalledWith(
      'content-type',
      'application/problem+json; charset=utf-8',
    );
    expect(sent).toEqual([
      {
        type: 'about:blank',
        title: 'Internal server error',
        status: 500,
        code: 'INTERNAL_ERROR',
        requestId: request.id,
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain(canary);
  });

  it('redacts free-form credentials before the exception reaches the final log output', async () => {
    const destination = new PassThrough();
    let output = '';
    destination.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const logger = new StructuredLogger({
      service: 'api',
      environment: 'test',
      version: 'test',
      level: 'info',
      format: 'json',
      destination,
    });
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const request = {
      id: '018f4f7a-3c2b-7b11-8abc-0123456789ab',
      method: 'GET',
      routeOptions: { url: '/api/v1/future' },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const canary = 'exception-filter-canary';

    new SafeExceptionFilter(logger).catch(new Error(`password: "${canary}"`), host);
    logger.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(output).toContain('http.request.failed');
    expect(output).not.toContain(canary);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
  });
});
