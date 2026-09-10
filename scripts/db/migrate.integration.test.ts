import { describe, expect, it } from 'vitest';

import { loadMigrationConfig } from '../../packages/config/src/index.js';
import { runDatabaseVerification } from './verification.js';

describe('PostgreSQL/PostGIS migration matrix', () => {
  it('proves clean, repeat, rollback, failure, concurrency, privileges, and outbox behavior', async () => {
    const config = loadMigrationConfig();
    const evidence = await runDatabaseVerification(config.databaseUrl);

    expect(evidence).toEqual({
      postgis: true,
      cleanApply: true,
      repeatNoOp: true,
      rollbackRollForward: true,
      invalidMigrationRolledBack: true,
      concurrentSerialized: true,
      runtimeDdlDenied: true,
      runtimeIdentityRestricted: true,
      outboxAtomicity: true,
      outboxStateIntegrity: true,
      outboxStateTransitions: true,
      outboxImmutableDataDenied: true,
      outboxMetadataMutationDenied: true,
      outboxDeleteDenied: true,
    });
  });
});
