import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { DatabaseProbe } from '../database-probe';
import type { RuntimeState } from '../runtime-state';
import { APP_DATABASE_PROBE, RUNTIME_STATE } from '../tokens';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_DATABASE_PROBE) private readonly database: DatabaseProbe,
    @Inject(RUNTIME_STATE) private readonly runtime: RuntimeState,
  ) {}

  @Get('live')
  live(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<{
    readonly status: 'ready' | 'not_ready';
    readonly checks: { readonly database: 'up' | 'down' };
  }> {
    if (!this.runtime.acceptsTraffic()) {
      reply.code(503);
      return { status: 'not_ready', checks: { database: 'down' } };
    }

    const result = await this.database.check();
    if (result.status !== 'up') {
      reply.code(503);
      return { status: 'not_ready', checks: { database: 'down' } };
    }
    return { status: 'ready', checks: { database: 'up' } };
  }
}
