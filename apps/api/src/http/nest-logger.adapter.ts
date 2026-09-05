import type { LoggerService } from '@nestjs/common';

import type { Logger } from '@trayvi/observability';

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info('framework.log', { message, optionalParams });
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error('framework.fatal', message, { optionalParams });
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error('framework.error', message, { optionalParams });
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn('framework.warning', { message, optionalParams });
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug('framework.debug', { message, optionalParams });
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug('framework.verbose', { message, optionalParams });
  }
}
