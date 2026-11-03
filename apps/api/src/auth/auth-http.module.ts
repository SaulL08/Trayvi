import { Module } from '@nestjs/common';

/**
 * SPEC-001 composition root for Auth HTTP routes. The integration scaffold leaves it empty; ws-e
 * owns this directory and composes the real implementations here.
 */
@Module({})
export class AuthHttpModule {}
