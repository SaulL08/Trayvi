import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';

import { getRequestContext } from './request-context';
import { sanitizeForLogging, sanitizeLogRecord } from './redaction';

export interface LoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly version: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly format: 'json' | 'pretty';
  readonly destination?: DestinationStream;
}

export interface Logger {
  debug(event: string, context?: Readonly<Record<string, unknown>>): void;
  info(event: string, context?: Readonly<Record<string, unknown>>): void;
  warn(event: string, context?: Readonly<Record<string, unknown>>): void;
  error(event: string, error: unknown, context?: Readonly<Record<string, unknown>>): void;
  flush(): void;
}

export class StructuredLogger implements Logger {
  readonly #logger: PinoLogger;

  constructor(options: LoggerOptions) {
    const destination =
      options.destination ??
      (options.format === 'pretty'
        ? pino.transport({
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
          })
        : undefined);

    this.#logger = pino(
      {
        level: options.level,
        base: {
          service: options.service,
          environment: options.environment,
          version: options.version,
        },
        messageKey: 'message',
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination,
    );
  }

  debug(event: string, context: Readonly<Record<string, unknown>> = {}): void {
    this.#write('debug', event, context);
  }

  info(event: string, context: Readonly<Record<string, unknown>> = {}): void {
    this.#write('info', event, context);
  }

  warn(event: string, context: Readonly<Record<string, unknown>> = {}): void {
    this.#write('warn', event, context);
  }

  error(event: string, error: unknown, context: Readonly<Record<string, unknown>> = {}): void {
    this.#write('error', event, { ...context, error: sanitizeForLogging(error) });
  }

  flush(): void {
    this.#logger.flush();
  }

  #write(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    suppliedContext: Readonly<Record<string, unknown>>,
  ): void {
    const requestContext = getRequestContext();
    const sanitizedEvent = sanitizeForLogging(event);
    const safeEvent = typeof sanitizedEvent === 'string' ? sanitizedEvent : '[UNSANITIZABLE]';
    const context = sanitizeLogRecord({
      ...(requestContext ?? {}),
      ...suppliedContext,
      event: safeEvent,
    });
    this.#logger[level](context, safeEvent);
  }
}
