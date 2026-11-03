import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConfiguredFingerprintKeyring,
  NodeIdentityDocumentProtector,
  NodeKeyedRequestCommitter,
  SyntheticAesGcmKeyEncryptionProvider,
} from '@trayvi/identity';
import { createOpaqueId } from '@trayvi/observability';
import {
  closeInitializedDatabaseClients,
  createDisposableDatabase,
  createRestrictedRuntimeLogin,
  dropDisposableDatabase,
  dropRestrictedRuntimeLogin,
  ensureDatabaseBootstrap,
} from '@trayvi/test-support';

import { loadMigrationConfig } from '../../../packages/config/src/index';
import { SqlMigrator } from '../../../scripts/db/migrate';
import { SafePublicError } from '../src/http/safe-public-error';
import {
  PostgresDocumentKekRewrapStore,
  PostgresFingerprintRotationStore,
} from '../src/phase-01/postgres-fingerprint-rotation';
import { PostgresPhaseOneStore } from '../src/phase-01/postgres-phase-one-store';
import { PhaseOneEnrollmentService } from '../src/phase-01/phase-one-enrollment';
import type {
  EnrollmentCheckpoint,
  EnrollmentMutationProbe,
} from '../src/phase-01/phase-one-enrollment';

const fingerprintV1 = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const fingerprintV2 = Buffer.from(
  '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f',
  'hex',
);
const kek = Buffer.from('303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f', 'hex');
const idempotencyKey = Buffer.from(
  '505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f',
  'hex',
);

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function protectorFor(versions: readonly ('v1' | 'v2')[]): NodeIdentityDocumentProtector {
  return new NodeIdentityDocumentProtector(
    new ConfiguredFingerprintKeyring(
      versions.map((version, index) => ({
        version: `fingerprint-${version}`,
        key: version === 'v1' ? fingerprintV1 : fingerprintV2,
        state: index === versions.length - 1 ? ('PRIMARY' as const) : ('LOOKUP_ACTIVE' as const),
      })),
    ),
    new SyntheticAesGcmKeyEncryptionProvider('kek-test-v1', new Map([['kek-test-v1', kek]])),
    new NodeKeyedRequestCommitter('idempotency-test-v1', idempotencyKey),
  );
}

interface TableCounts {
  readonly accounts: number;
  readonly identities: number;
  readonly documents: number;
  readonly claims: number;
  readonly accountTransitions: number;
  readonly identityTransitions: number;
  readonly outbox: number;
}

interface DataInventory {
  readonly status: string;
  readonly productionEnablement: string;
  readonly tables: readonly {
    readonly table: string;
    readonly owner: string;
    readonly fieldGroups: readonly {
      readonly fields: readonly string[];
      readonly classification: string;
      readonly purpose: string;
      readonly readers: readonly string[];
      readonly writers: readonly string[];
      readonly retentionTrigger: string;
      readonly deletionAction: string;
      readonly legalHold: string;
      readonly eventPolicy: string;
      readonly telemetryPolicy: string;
    }[];
  }[];
}

describe('Phase 1 accounts and identity on real PostgreSQL', () => {
  const adminConfig = loadMigrationConfig();
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let migrator: SqlMigrator;
  let pool: Pool;
  // HMAC backfill, KEK rewrap, and key-policy changes run as the least-privilege rotation workload.
  let rotationPool: Pool | undefined;
  let rotationLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;

  const createService = (
    protector = protectorFor(['v1']),
    probe?: EnrollmentMutationProbe,
    clock: () => Date = () => new Date(),
    operationTtlMs?: number,
  ): PhaseOneEnrollmentService =>
    new PhaseOneEnrollmentService(
      new PostgresPhaseOneStore(pool, probe),
      protector,
      createOpaqueId,
      clock,
      operationTtlMs === undefined ? {} : { operationTtlMs },
    );

  const rotation = (): Pool => {
    if (!rotationPool) throw new Error('rotation pool is not initialized');
    return rotationPool;
  };

  const setFingerprintKeyPolicy = async (versions: readonly string[]): Promise<void> => {
    await rotation().query('SELECT identity.set_fingerprint_key_policy($1::varchar[])', [versions]);
  };

  const start = async (service: PhaseOneEnrollmentService, suffix: string): Promise<string> => {
    const result = await service.startAccountCreation({
      callerBinding: `caller-${suffix}`,
      idempotencyKey: `start-${suffix}`,
      channel: 'WEB',
      locale: 'es-DO',
    });
    return result.operationId;
  };

  const counts = async (): Promise<TableCounts> => {
    const result = await pool.query<{
      accounts: string;
      identities: string;
      documents: string;
      claims: string;
      account_transitions: string;
      identity_transitions: string;
      outbox: string;
    }>(`SELECT
      (SELECT count(*) FROM accounts.accounts)::text AS accounts,
      (SELECT count(*) FROM identity.person_identities)::text AS identities,
      (SELECT count(*) FROM identity.identity_documents)::text AS documents,
      (SELECT count(*) FROM identity.document_fingerprint_claims)::text AS claims,
      (SELECT count(*) FROM accounts.account_status_transitions)::text AS account_transitions,
      (SELECT count(*) FROM identity.identity_status_transitions)::text AS identity_transitions,
      (SELECT count(*) FROM platform.outbox_events)::text AS outbox`);
    const row = result.rows[0];
    if (!row) throw new Error('count query returned no row');
    return {
      accounts: Number(row.accounts),
      identities: Number(row.identities),
      documents: Number(row.documents),
      claims: Number(row.claims),
      accountTransitions: Number(row.account_transitions),
      identityTransitions: Number(row.identity_transitions),
      outbox: Number(row.outbox),
    };
  };

  beforeAll(async () => {
    await ensureDatabaseBootstrap(adminConfig.databaseUrl);
    database = await createDisposableDatabase(adminConfig.databaseUrl, 'trayvi_phase_one');
    migrator = new SqlMigrator(database.url);
    await migrator.up();
    pool = new Pool({ connectionString: database.url, max: 60, statement_timeout: 30_000 });
    rotationLogin = await createRestrictedRuntimeLogin(
      adminConfig.databaseUrl,
      database.url,
      'trayvi_rotation',
    );
    rotationPool = new Pool({ connectionString: rotationLogin.url, max: 4 });
    await setFingerprintKeyPolicy(['fingerprint-v1']);
  });

  afterAll(async () => {
    await rotationPool?.end();
    if (rotationLogin) {
      await dropRestrictedRuntimeLogin(
        adminConfig.databaseUrl,
        rotationLogin.name,
        'trayvi_rotation',
      );
    }
    await closeInitializedDatabaseClients({ pool, migrator });
    if (database) {
      await delay(100);
      await dropDisposableDatabase(adminConfig.databaseUrl, database.name);
    }
  });

  it('applies all ten migrations and rejects invalid direct initial states', async () => {
    expect((await migrator.status()).map((migration) => migration.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
    ]);

    await expect(
      pool.query(
        `INSERT INTO accounts.accounts
         (id, status, status_reason_code, version, created_at, updated_at)
         VALUES ($1, 'ACTIVE', 'BYPASS', 0, clock_timestamp(), clock_timestamp())`,
        [createOpaqueId()],
      ),
    ).rejects.toMatchObject({ constraint: 'account_lifecycle_transition' });

    await expect(
      pool.query(
        `INSERT INTO accounts.accounts
         (id, status, status_reason_code, version, created_at, updated_at)
         VALUES ($1, 'PENDING_IDENTITY', 'BYPASS', 0, clock_timestamp(), clock_timestamp())`,
        [createOpaqueId()],
      ),
    ).rejects.toMatchObject({ constraint: 'account_transition_evidence_required' });
  });

  it('maps every Phase 1 PostgreSQL column to a complete privacy inventory entry', async () => {
    const readInventory = async (path: string): Promise<DataInventory> =>
      JSON.parse(await readFile(resolve(path), 'utf8')) as DataInventory;
    const original = await readInventory(
      'docs/phases/phase-01-accounts-identity/evidence/data-inventory.json',
    );
    // The original inventory is hash-pinned evidence; remediation tables live in an addendum.
    const addendum = await readInventory(
      'docs/phases/phase-01-accounts-identity/evidence/remediation/data-inventory-addendum.json',
    );
    expect(addendum.status).toBe(original.status);
    expect(addendum.productionEnablement).toBe(original.productionEnablement);
    const inventory: DataInventory = {
      ...original,
      tables: [...original.tables, ...addendum.tables],
    };
    const catalog = await pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
       WHERE table_schema IN ('accounts', 'identity')
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    const catalogFields = catalog.rows
      .map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`)
      .sort();
    const inventoriedFields = inventory.tables
      .flatMap((table) =>
        table.fieldGroups.flatMap((group) => {
          expect(table.owner.length).toBeGreaterThan(0);
          expect(group.classification.length).toBeGreaterThan(0);
          expect(group.purpose.length).toBeGreaterThan(0);
          expect(group.readers.length).toBeGreaterThan(0);
          expect(group.writers.length).toBeGreaterThan(0);
          expect(group.retentionTrigger.length).toBeGreaterThan(0);
          expect(group.deletionAction.length).toBeGreaterThan(0);
          expect(group.legalHold.length).toBeGreaterThan(0);
          expect(group.eventPolicy.length).toBeGreaterThan(0);
          expect(group.telemetryPolicy.length).toBeGreaterThan(0);
          return group.fields.map((field) => `${table.table}.${field}`);
        }),
      )
      .sort();

    expect(inventory.status).toBe('IMPLEMENTED_PENDING_GOVERNANCE_APPROVAL');
    expect(inventory.productionEnablement).toBe('BLOCKED');
    expect(new Set(inventoriedFields).size).toBe(inventoriedFields.length);
    expect(inventoriedFields).toEqual(catalogFields);
  });

  it('creates, replays, verifies, and activates one aggregate without exposing document data', async () => {
    const service = createService();
    const startInput = {
      callerBinding: 'happy-caller',
      idempotencyKey: 'happy-start',
      channel: 'WEB',
      locale: 'es-DO',
    } as const;
    const started = await service.startAccountCreation(startInput);
    const startReplay = await service.startAccountCreation(startInput);
    expect(startReplay.operationId).toBe(started.operationId);
    await expect(
      service.startAccountCreation({ ...startInput, locale: 'en-US' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const documentCanary = '100-0000000-1';
    const accepted = await service.submitIdentityInformation({
      operationId: started.operationId,
      documentValue: documentCanary,
      correlationId: createOpaqueId(),
    });
    expect(accepted).toEqual({
      operationId: started.operationId,
      code: 'IDENTITY_SUBMISSION_ACCEPTED',
      nextStep: 'CONTINUE_SECURELY',
    });
    expect(JSON.stringify(accepted)).not.toContain(documentCanary);
    const afterFirstSubmission = await counts();
    await expect(
      service.submitIdentityInformation({
        operationId: started.operationId,
        documentValue: '10000000001',
        correlationId: createOpaqueId(),
      }),
    ).resolves.toEqual(accepted);
    expect(await counts()).toEqual(afterFirstSubmission);
    await expect(
      service.submitIdentityInformation({
        operationId: started.operationId,
        documentValue: '10000000002',
        correlationId: createOpaqueId(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.submitIdentityInformation({
        operationId: createOpaqueId(),
        documentValue: documentCanary,
        correlationId: createOpaqueId(),
      }),
    ).rejects.toBeInstanceOf(SafePublicError);

    const aggregate = await pool.query<{
      account_id: string;
      identity_id: string;
      account_status: string;
      identity_status: string;
      ciphertext: Buffer;
      document_id: string;
    }>(
      `SELECT account.id AS account_id, person_identity.id AS identity_id,
              account.status AS account_status, person_identity.status AS identity_status,
              document.ciphertext, document.id AS document_id
       FROM accounts.account_creation_operations operation
       JOIN accounts.accounts account ON account.id = operation.account_id
       JOIN identity.person_identities person_identity ON person_identity.account_id = account.id
       JOIN identity.identity_documents document ON document.identity_id = person_identity.id
       WHERE operation.id = $1`,
      [started.operationId],
    );
    const row = aggregate.rows[0];
    expect(row).toMatchObject({
      account_status: 'PENDING_IDENTITY',
      identity_status: 'PENDING',
    });
    expect(
      [
        started.operationId,
        row?.account_id ?? '',
        row?.identity_id ?? '',
        row?.document_id ?? '',
      ].every(isUuidV7),
    ).toBe(true);
    expect(row?.ciphertext.toString('utf8')).not.toContain('10000000001');

    await expect(
      pool.query(
        `UPDATE accounts.accounts
         SET status = 'ACTIVE', status_reason_code = 'UNTRUSTED_FORMAT_ONLY',
             version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1`,
        [row?.account_id],
      ),
    ).rejects.toBeDefined();

    const decisionId = createOpaqueId();
    const verification = {
      outcome: 'VERIFIED' as const,
      decisionId,
      identityId: row?.identity_id ?? '',
      methodClass: 'SYNTHETIC_ATTESTATION',
      resultCode: 'VERIFIED_SYNTHETIC',
      policyVersion: 'phase-one-test-v1',
      providerAlias: 'SYNTHETIC',
      evidenceType: 'SYNTHETIC_ATTESTATION',
      evidenceDigest: createHash('sha256').update('synthetic-evidence').digest(),
      restrictedEvidenceReference: 'synthetic-evidence-reference',
      retentionClass: 'SYNTHETIC_TEST_ONLY',
      actorReference: 'trusted-test-adapter',
      correlationId: createOpaqueId(),
    };
    await expect(service.recordTrustedVerification(verification)).resolves.toBe('RECORDED');
    await expect(service.recordTrustedVerification(verification)).resolves.toBe('REPLAY');

    const activated = await pool.query<{
      account_status: string;
      identity_status: string;
      claim_state: string;
    }>(
      `SELECT account.status AS account_status,
              person_identity.status AS identity_status,
              claim.state AS claim_state
       FROM accounts.accounts account
       JOIN identity.person_identities person_identity ON person_identity.account_id = account.id
       JOIN identity.identity_documents document ON document.identity_id = person_identity.id
       JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
       WHERE account.id = $1`,
      [row?.account_id],
    );
    expect(activated.rows).toEqual([
      { account_status: 'ACTIVE', identity_status: 'ESTABLISHED', claim_state: 'BOUND' },
    ]);

    const transitionEvidence = await pool.query<{
      actor_class: string;
      reason_code: string;
      evidence_reference: string;
      aggregate_version: number;
      occurred_at: Date;
    }>(
      `SELECT actor_class, reason_code, evidence_reference, aggregate_version, occurred_at
       FROM identity.identity_status_transitions
       WHERE identity_id = $1 AND aggregate_version = 1`,
      [row?.identity_id],
    );
    expect(transitionEvidence.rows[0]).toMatchObject({
      actor_class: 'TRUSTED_VERIFICATION_HANDLER',
      reason_code: 'IDENTITY_ESTABLISHED',
      aggregate_version: 1,
    });
    expect(transitionEvidence.rows[0]?.evidence_reference).toMatch(/^[0-9a-f-]{36}$/u);
    expect(transitionEvidence.rows[0]?.occurred_at).toBeInstanceOf(Date);

    for (const statement of [
      `UPDATE accounts.accounts SET status = 'PENDING_IDENTITY',
         status_reason_code = 'ILLEGAL_REOPEN', version = version + 1,
         updated_at = clock_timestamp() WHERE id = '${row?.account_id ?? ''}'`,
      `UPDATE identity.person_identities SET status = 'PENDING',
         status_reason_code = 'ILLEGAL_REOPEN', version = version + 1,
         updated_at = clock_timestamp(), established_at = NULL
         WHERE id = '${row?.identity_id ?? ''}'`,
      `UPDATE identity.verification_cases SET status = 'PENDING', decision_id = NULL,
         result_code = NULL, resolved_at = NULL WHERE identity_id = '${row?.identity_id ?? ''}'`,
      `UPDATE identity.identity_reviews review SET state = 'QUEUED', resolved_at = NULL
         FROM identity.verification_cases verification
         WHERE review.case_id = verification.id AND verification.identity_id = '${row?.identity_id ?? ''}'`,
      `UPDATE identity.document_fingerprint_claims claim SET state = 'RESERVED', bound_at = NULL
         FROM identity.identity_documents document
         WHERE claim.document_id = document.id AND document.identity_id = '${row?.identity_id ?? ''}'`,
      `UPDATE identity.identity_status_transitions SET reason_code = 'TAMPERED'
         WHERE identity_id = '${row?.identity_id ?? ''}'`,
    ]) {
      await expect(pool.query(statement)).rejects.toBeDefined();
    }

    const outbox = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox_events
       WHERE aggregate_id IN ($1, $2)`,
      [row?.account_id, row?.identity_id],
    );
    const serialized = JSON.stringify(outbox.rows);
    expect(serialized).not.toContain('10000000001');
    expect(serialized).not.toMatch(/fingerprint|ciphertext|wrapped|nonce|documentValue/iu);
  });

  it('rejects expired operations with the same safe public envelope', async () => {
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    const service = createService(protectorFor(['v1']), undefined, () => oldTime, 1);
    const operationId = await start(service, 'expired');

    await expect(
      service.submitIdentityInformation({
        operationId,
        documentValue: '11000000001',
        correlationId: createOpaqueId(),
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANNOT_BE_COMPLETED' });
    await expect(
      pool.query(`SELECT state FROM accounts.account_creation_operations WHERE id = $1`, [
        operationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'EXPIRED' }] });
  });

  it('serializes concurrent replays and rejects mismatched malicious reuse without mutation', async () => {
    const service = createService();
    const operationId = await start(service, 'concurrent-replay');
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.submitIdentityInformation({
          operationId,
          documentValue: '120-0000000-1',
          correlationId: createOpaqueId(),
        }),
      ),
    );
    expect(new Set(responses.map((response) => JSON.stringify(response)))).toEqual(
      new Set([
        JSON.stringify({
          operationId,
          code: 'IDENTITY_SUBMISSION_ACCEPTED',
          nextStep: 'CONTINUE_SECURELY',
        }),
      ]),
    );
    const afterReplay = await counts();
    await expect(
      service.submitIdentityInformation({
        operationId,
        documentValue: '12000000002',
        correlationId: createOpaqueId(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await counts()).toEqual(afterReplay);
  });

  it('keeps new and duplicate public outcomes in the same schema and size class', async () => {
    const service = createService();
    const firstOperation = await start(service, 'oracle-new');
    const newOutcome = await service.submitIdentityInformation({
      operationId: firstOperation,
      documentValue: '13000000001',
      correlationId: createOpaqueId(),
    });
    const duplicateOperation = await start(service, 'oracle-duplicate');
    const duplicateOutcome = await service.submitIdentityInformation({
      operationId: duplicateOperation,
      documentValue: '130-0000000-1',
      correlationId: createOpaqueId(),
    });

    expect(Object.keys(duplicateOutcome)).toEqual(Object.keys(newOutcome));
    expect(duplicateOutcome).toMatchObject({
      code: newOutcome.code,
      nextStep: newOutcome.nextStep,
    });
    expect(JSON.stringify(duplicateOutcome)).toHaveLength(JSON.stringify(newOutcome).length);
    expect(JSON.stringify(duplicateOutcome)).not.toMatch(/accountId|identityId|documentValue/iu);
    const internal = await pool.query<{ state: string; account_id: string | null }>(
      `SELECT state, account_id FROM accounts.account_creation_operations
       WHERE id = $1`,
      [duplicateOperation],
    );
    expect(internal.rows[0]).toEqual({ state: 'CONFLICT', account_id: null });
  });

  it('proves exactly one winner across 50 attempts for each of 10 rounds', async () => {
    const service = createService();
    let winners = 0;
    let conflicts = 0;
    for (let round = 0; round < 10; round += 1) {
      const operations = await Promise.all(
        Array.from({ length: 50 }, (_, attempt) => start(service, `race-${round}-${attempt}`)),
      );
      const responses = await Promise.all(
        operations.map((operationId) =>
          service.submitIdentityInformation({
            operationId,
            documentValue: `2000000000${round}`,
            correlationId: createOpaqueId(),
          }),
        ),
      );
      expect(new Set(responses.map((response) => response.code))).toEqual(
        new Set(['IDENTITY_SUBMISSION_ACCEPTED']),
      );
      const outcomes = await pool.query<{ state: string; count: string }>(
        `SELECT state, count(*)::text AS count
           FROM accounts.account_creation_operations
           WHERE id = ANY($1::uuid[])
           GROUP BY state`,
        [operations],
      );
      const byState = Object.fromEntries(
        outcomes.rows.map((outcome) => [outcome.state, Number(outcome.count)]),
      );
      expect(byState).toEqual({ COMPLETED: 1, CONFLICT: 49 });
      winners += byState.COMPLETED ?? 0;
      conflicts += byState.CONFLICT ?? 0;

      const winner = await pool.query<{ identity_id: string }>(
        `SELECT person_identity.id AS identity_id
           FROM accounts.account_creation_operations operation
           JOIN identity.person_identities person_identity
             ON person_identity.account_id = operation.account_id
           WHERE operation.id = ANY($1::uuid[]) AND operation.state = 'COMPLETED'`,
        [operations],
      );
      await service.recordTrustedVerification({
        outcome: 'VERIFIED',
        decisionId: createOpaqueId(),
        identityId: winner.rows[0]?.identity_id ?? '',
        methodClass: 'SYNTHETIC_ATTESTATION',
        resultCode: 'VERIFIED_SYNTHETIC',
        policyVersion: 'phase-one-test-v1',
        providerAlias: 'SYNTHETIC',
        evidenceType: 'SYNTHETIC_ATTESTATION',
        evidenceDigest: createHash('sha256').update(`race-evidence-${round}`).digest(),
        restrictedEvidenceReference: `synthetic-race-reference-${round}`,
        retentionClass: 'SYNTHETIC_TEST_ONLY',
        actorReference: 'trusted-test-adapter',
        correlationId: createOpaqueId(),
      });
      const aggregateCounts = await pool.query<{
        accounts: string;
        identities: string;
        documents: string;
        active: string;
        orphans: string;
      }>(
        `SELECT
             count(DISTINCT account.id)::text AS accounts,
             count(DISTINCT person_identity.id)::text AS identities,
             count(DISTINCT document.id)::text AS documents,
             count(DISTINCT account.id) FILTER (WHERE account.status = 'ACTIVE')::text AS active,
             count(DISTINCT account.id) FILTER (
               WHERE person_identity.id IS NULL OR document.id IS NULL
             )::text AS orphans
           FROM accounts.account_creation_operations operation
           LEFT JOIN accounts.accounts account ON account.id = operation.account_id
           LEFT JOIN identity.person_identities person_identity ON person_identity.account_id = account.id
           LEFT JOIN identity.identity_documents document ON document.identity_id = person_identity.id
           WHERE operation.id = ANY($1::uuid[])`,
        [operations],
      );
      expect(aggregateCounts.rows[0]).toEqual({
        accounts: '1',
        identities: '1',
        documents: '1',
        active: '1',
        orphans: '0',
      });
    }
    expect({ attempts: 500, rounds: 10, winners, conflicts }).toEqual({
      attempts: 500,
      rounds: 10,
      winners: 10,
      conflicts: 490,
    });
  }, 120_000);

  it('rolls back every aggregate mutation checkpoint without orphans', async () => {
    const checkpoints: readonly EnrollmentCheckpoint[] = [
      'ACCOUNT_INSERTED',
      'IDENTITY_INSERTED',
      'DOCUMENT_ENVELOPE_INSERTED',
      'FINGERPRINT_CLAIMS_INSERTED',
      'TRANSITION_HISTORY_INSERTED',
      'OUTBOX_INSERTED',
      'IDEMPOTENCY_RESULT_RECORDED',
    ];
    for (const [index, target] of checkpoints.entries()) {
      const probe: EnrollmentMutationProbe = {
        checkpoint: (actual) =>
          actual === target ? Promise.reject(new Error(`INJECTED_${target}`)) : Promise.resolve(),
      };
      const service = createService(protectorFor(['v1']), probe);
      const operationId = await start(service, `failure-${index}`);
      const before = await counts();
      await expect(
        service.submitIdentityInformation({
          operationId,
          documentValue: `3000000000${index}`,
          correlationId: createOpaqueId(),
        }),
      ).rejects.toThrow(`INJECTED_${target}`);
      expect(await counts()).toEqual(before);
      const operation = await pool.query<{ state: string }>(
        `SELECT state FROM accounts.account_creation_operations WHERE id = $1`,
        [operationId],
      );
      expect(operation.rows[0]?.state).toBe('STARTED');
    }
  });

  it('fails closed for writers missing a policy-required HMAC key version', async () => {
    const v1Service = createService(protectorFor(['v1']));
    const v2Service = createService(protectorFor(['v2']));
    const writers = Array.from({ length: 60 }, (_, index) =>
      index % 2 === 0 ? v1Service : v2Service,
    );
    const operations = await Promise.all(
      writers.map((service, index) => start(service, `disjoint-${index}`)),
    );
    const outcomes = await Promise.allSettled(
      operations.map((operationId, index) =>
        (writers[index] ?? v1Service).submitIdentityInformation({
          operationId,
          documentValue: '41000000001',
          correlationId: createOpaqueId(),
        }),
      ),
    );
    const v1Outcomes = outcomes.filter((_, index) => index % 2 === 0);
    const v2Outcomes = outcomes.filter((_, index) => index % 2 === 1);
    expect(v1Outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    for (const outcome of v2Outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({
          constraint: 'document_fingerprint_key_policy_unsatisfied',
        });
      }
    }
    const states = await pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
       FROM accounts.account_creation_operations
       WHERE id = ANY($1::uuid[]) GROUP BY state ORDER BY state`,
      [operations],
    );
    expect(states.rows).toEqual([
      { state: 'COMPLETED', count: '1' },
      { state: 'CONFLICT', count: '29' },
      { state: 'STARTED', count: '30' },
    ]);

    // Requiring both versions makes a stale single-version writer fail closed too.
    await setFingerprintKeyPolicy(['fingerprint-v1', 'fingerprint-v2']);
    try {
      const staleOperation = await start(v1Service, 'disjoint-stale');
      await expect(
        v1Service.submitIdentityInformation({
          operationId: staleOperation,
          documentValue: '42000000001',
          correlationId: createOpaqueId(),
        }),
      ).rejects.toMatchObject({ constraint: 'document_fingerprint_key_policy_unsatisfied' });
      // Retiring v1 before every blocking document holds a v2 fingerprint is refused.
      await expect(setFingerprintKeyPolicy(['fingerprint-v2'])).rejects.toMatchObject({
        constraint: 'fingerprint_key_policy_coverage',
      });
      await expect(setFingerprintKeyPolicy([])).rejects.toThrow('FINGERPRINT_KEY_POLICY_INVALID');
    } finally {
      await setFingerprintKeyPolicy(['fingerprint-v1']);
    }
  });

  it('backfills a dual-active HMAC alias before retiring the old lookup key', async () => {
    const oldProtector = protectorFor(['v1']);
    const oldService = createService(oldProtector);
    const originalOperation = await start(oldService, 'rotation-original');
    await oldService.submitIdentityInformation({
      operationId: originalOperation,
      documentValue: '40000000001',
      correlationId: createOpaqueId(),
    });
    const document = await pool.query<{ document_id: string }>(
      `SELECT document.id AS document_id
       FROM accounts.account_creation_operations operation
       JOIN identity.person_identities person_identity ON person_identity.account_id = operation.account_id
       JOIN identity.identity_documents document ON document.identity_id = person_identity.id
       WHERE operation.id = $1`,
      [originalOperation],
    );
    const targetKeyring = new ConfiguredFingerprintKeyring([
      { version: 'fingerprint-v1', key: fingerprintV1, state: 'LOOKUP_ACTIVE' },
      { version: 'fingerprint-v2', key: fingerprintV2, state: 'PRIMARY' },
    ]);
    const rotationStore = new PostgresFingerprintRotationStore(rotation(), oldProtector);
    const conflictingAliasId = createOpaqueId();
    await pool.query(
      `INSERT INTO identity.document_fingerprint_claims (
         id, document_id, country_code, issuer_code, document_type,
         normalization_profile, hmac_algorithm, hmac_key_version,
         fingerprint, state, created_at
       )
       SELECT $1, id, country_code, issuer_code, document_type,
              normalization_profile, 'hmac-sha-256', 'fingerprint-v2',
              $2, 'RESERVED', clock_timestamp()
       FROM identity.identity_documents WHERE id = $3`,
      [conflictingAliasId, Buffer.alloc(32, 9), document.rows[0]?.document_id],
    );
    await expect(
      rotationStore.backfill({
        documentId: document.rows[0]?.document_id ?? '',
        targetKeyring,
        aliasIdFactory: createOpaqueId,
        eventId: createOpaqueId(),
        correlationId: createOpaqueId(),
        occurredAt: new Date(),
      }),
    ).rejects.toThrow('ROTATION_BACKFILL_INCOMPLETE');
    await pool.query(`DELETE FROM identity.document_fingerprint_claims WHERE id = $1`, [
      conflictingAliasId,
    ]);

    const dualService = createService(protectorFor(['v1', 'v2']));
    const rotationOperations = await Promise.all(
      Array.from({ length: 20 }, (_, index) => start(dualService, `rotation-race-${index}`)),
    );
    const rotationEventId = createOpaqueId();
    const [backfillCount, rotationOutcomes] = await Promise.all([
      rotationStore.backfill({
        documentId: document.rows[0]?.document_id ?? '',
        targetKeyring,
        aliasIdFactory: createOpaqueId,
        eventId: rotationEventId,
        correlationId: createOpaqueId(),
        occurredAt: new Date(),
      }),
      Promise.all(
        rotationOperations.map((operationId) =>
          dualService.submitIdentityInformation({
            operationId,
            documentValue: '400-0000000-1',
            correlationId: createOpaqueId(),
          }),
        ),
      ),
    ]);
    expect(backfillCount).toBe(2);
    expect(
      rotationOutcomes.every((outcome) => outcome.code === 'IDENTITY_SUBMISSION_ACCEPTED'),
    ).toBe(true);
    const rotationStates = await pool.query<{ state: string; count: string }>(
      `SELECT state, count(*)::text AS count
       FROM accounts.account_creation_operations
       WHERE id = ANY($1::uuid[]) GROUP BY state`,
      [rotationOperations],
    );
    expect(rotationStates.rows).toEqual([{ state: 'CONFLICT', count: '20' }]);
    await expect(
      rotationStore.backfill({
        documentId: document.rows[0]?.document_id ?? '',
        targetKeyring,
        aliasIdFactory: createOpaqueId,
        eventId: rotationEventId,
        correlationId: createOpaqueId(),
        occurredAt: new Date(),
      }),
    ).resolves.toBe(2);
    const aliases = await pool.query<{ hmac_key_version: string }>(
      `SELECT hmac_key_version FROM identity.document_fingerprint_claims
       WHERE document_id = $1 ORDER BY hmac_key_version`,
      [document.rows[0]?.document_id],
    );
    expect(aliases.rows.map((row) => row.hmac_key_version)).toEqual([
      'fingerprint-v1',
      'fingerprint-v2',
    ]);

    const envelopeBefore = await pool.query<{
      ciphertext: Buffer;
      wrapped_dek: Buffer;
      kek_key_version: string;
    }>(
      `SELECT ciphertext, wrapped_dek, kek_key_version
       FROM identity.identity_documents WHERE id = $1`,
      [document.rows[0]?.document_id],
    );
    const newKek = Buffer.alloc(32, 73);
    const wrongProvider = new SyntheticAesGcmKeyEncryptionProvider(
      'kek-test-v2',
      new Map([
        ['kek-test-v1', Buffer.alloc(32, 72)],
        ['kek-test-v2', newKek],
      ]),
    );
    const targetKeyringForRewrap = new ConfiguredFingerprintKeyring([
      { version: 'fingerprint-v2', key: fingerprintV2, state: 'PRIMARY' },
    ]);
    const wrongProtector = new NodeIdentityDocumentProtector(
      targetKeyringForRewrap,
      wrongProvider,
      new NodeKeyedRequestCommitter('idempotency-test-v1', idempotencyKey),
    );
    await expect(
      new PostgresDocumentKekRewrapStore(rotation(), wrongProvider, wrongProtector).rewrap({
        documentId: document.rows[0]?.document_id ?? '',
        targetKekKeyVersion: 'kek-test-v2',
        eventId: createOpaqueId(),
        correlationId: createOpaqueId(),
        occurredAt: new Date(),
      }),
    ).rejects.toBeDefined();

    const rewrapProvider = new SyntheticAesGcmKeyEncryptionProvider(
      'kek-test-v2',
      new Map([
        ['kek-test-v1', kek],
        ['kek-test-v2', newKek],
      ]),
    );
    const rewrapProtector = new NodeIdentityDocumentProtector(
      targetKeyringForRewrap,
      rewrapProvider,
      new NodeKeyedRequestCommitter('idempotency-test-v1', idempotencyKey),
    );
    const rewrapStore = new PostgresDocumentKekRewrapStore(
      rotation(),
      rewrapProvider,
      rewrapProtector,
    );
    const rewrapEventId = createOpaqueId();
    const rewrapInput = {
      documentId: document.rows[0]?.document_id ?? '',
      targetKekKeyVersion: 'kek-test-v2',
      eventId: rewrapEventId,
      correlationId: createOpaqueId(),
      occurredAt: new Date(),
    } as const;
    await expect(rewrapStore.rewrap(rewrapInput)).resolves.toBe('REWRAPPED');
    await expect(rewrapStore.rewrap(rewrapInput)).resolves.toBe('REPLAY');
    const envelopeAfter = await pool.query<{
      ciphertext: Buffer;
      wrapped_dek: Buffer;
      kek_key_version: string;
    }>(
      `SELECT ciphertext, wrapped_dek, kek_key_version
       FROM identity.identity_documents WHERE id = $1`,
      [document.rows[0]?.document_id],
    );
    expect(envelopeAfter.rows[0]?.kek_key_version).toBe('kek-test-v2');
    expect(
      envelopeAfter.rows[0]?.ciphertext.equals(
        envelopeBefore.rows[0]?.ciphertext ?? Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(
      envelopeAfter.rows[0]?.wrapped_dek.equals(
        envelopeBefore.rows[0]?.wrapped_dek ?? Buffer.alloc(0),
      ),
    ).toBe(false);
    const rewrapEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox_events WHERE id = $1`,
      [rewrapEventId],
    );
    expect(rewrapEvents.rows).toHaveLength(1);
    expect(Object.keys(rewrapEvents.rows[0]?.payload ?? {}).sort()).toEqual([
      'documentId',
      'identityId',
      'state',
    ]);
    expect(JSON.stringify(rewrapEvents.rows)).not.toMatch(
      /kekKeyVersion|wrappedDek|ciphertext|nonce|authenticationTag/iu,
    );

    // Cutover protocol: require both versions, backfill every blocking document, then retire v1.
    await setFingerprintKeyPolicy(['fingerprint-v1', 'fingerprint-v2']);
    await expect(setFingerprintKeyPolicy(['fingerprint-v2'])).rejects.toMatchObject({
      constraint: 'fingerprint_key_policy_coverage',
    });
    const uncovered = await pool.query<{ document_id: string }>(
      `SELECT DISTINCT claim.document_id
       FROM identity.document_fingerprint_claims claim
       WHERE claim.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
         AND NOT EXISTS (
           SELECT 1 FROM identity.document_fingerprint_claims covering
           WHERE covering.document_id = claim.document_id
             AND covering.hmac_key_version = 'fingerprint-v2'
             AND covering.state IN ('RESERVED', 'BOUND', 'TOMBSTONED')
         )`,
    );
    expect(uncovered.rows.length).toBeGreaterThan(0);
    for (const { document_id: documentId } of uncovered.rows) {
      await rotationStore.backfill({
        documentId,
        targetKeyring,
        aliasIdFactory: createOpaqueId,
        eventId: createOpaqueId(),
        correlationId: createOpaqueId(),
        occurredAt: new Date(),
      });
    }
    await setFingerprintKeyPolicy(['fingerprint-v2']);

    const postCutoverService = createService(protectorFor(['v2']));
    const duplicateOperation = await start(postCutoverService, 'rotation-duplicate');
    await expect(
      postCutoverService.submitIdentityInformation({
        operationId: duplicateOperation,
        documentValue: '400-0000000-1',
        correlationId: createOpaqueId(),
      }),
    ).resolves.toMatchObject({ code: 'IDENTITY_SUBMISSION_ACCEPTED' });
    const duplicate = await pool.query<{ state: string; account_id: string | null }>(
      `SELECT state, account_id FROM accounts.account_creation_operations WHERE id = $1`,
      [duplicateOperation],
    );
    expect(duplicate.rows[0]).toEqual({ state: 'CONFLICT', account_id: null });
  });

  it('denies restricted reads, DDL, escalation, and direct lifecycle bypass to runtime', async () => {
    const runtime = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    const client = new Client({ connectionString: runtime.url });
    await client.connect();
    try {
      const account = await pool.query<{ id: string }>(
        `SELECT id FROM accounts.accounts WHERE status = 'ACTIVE' LIMIT 1`,
      );
      const denied = async (statement: string): Promise<boolean> => {
        await client.query('BEGIN');
        try {
          await client.query(statement);
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          return false;
        } catch {
          return true;
        } finally {
          await client.query('ROLLBACK');
        }
      };
      const statements = [
        'SELECT ciphertext FROM identity.identity_documents LIMIT 1',
        'SELECT fingerprint FROM identity.document_fingerprint_claims LIMIT 1',
        `UPDATE identity.identity_documents SET ciphertext = decode('00', 'hex')`,
        'DELETE FROM identity.identity_documents',
        'DELETE FROM identity.document_fingerprint_claims',
        'DELETE FROM accounts.accounts',
        'CREATE TABLE accounts.runtime_bypass (id integer)',
        'SET ROLE trayvi_migrator',
        `UPDATE accounts.accounts
           SET status = 'CLOSED', status_reason_code = 'RUNTIME_BYPASS',
               version = version + 1, updated_at = clock_timestamp(), closed_at = clock_timestamp()
           WHERE id = '${account.rows[0]?.id ?? ''}'`,
      ];
      const results: boolean[] = [];
      for (const statement of statements) {
        results.push(await denied(statement));
      }
      expect(results).toHaveLength(statements.length);
      expect(results.every(Boolean)).toBe(true);
    } finally {
      await client.end();
      await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, runtime.name);
    }
  });

  it('confines material transitions to the trusted verification command', async () => {
    const runtime = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    const verifier = await createRestrictedRuntimeLogin(
      adminConfig.databaseUrl,
      database.url,
      'trayvi_verification',
    );
    const runtimePool = new Pool({ connectionString: runtime.url, max: 4 });
    const verifierPool = new Pool({ connectionString: verifier.url, max: 2 });
    const serviceOn = (target: Pool): PhaseOneEnrollmentService =>
      new PhaseOneEnrollmentService(
        new PostgresPhaseOneStore(target),
        // The rotation test leaves the shared policy at {fingerprint-v2}.
        protectorFor(['v2']),
        createOpaqueId,
        () => new Date(),
      );
    try {
      // The general runtime still enrolls, appending only initial history.
      const runtimeService = serviceOn(runtimePool);
      const operationId = await start(runtimeService, 'command-boundary');
      await runtimeService.submitIdentityInformation({
        operationId,
        documentValue: '60000000001',
        correlationId: createOpaqueId(),
      });
      const aggregate = await pool.query<{ account_id: string; identity_id: string }>(
        `SELECT operation.account_id, person_identity.id AS identity_id
         FROM accounts.account_creation_operations operation
         JOIN identity.person_identities person_identity
           ON person_identity.account_id = operation.account_id
         WHERE operation.id = $1`,
        [operationId],
      );
      const accountId = aggregate.rows[0]?.account_id ?? '';
      const identityId = aggregate.rows[0]?.identity_id ?? '';
      expect([accountId, identityId].every(isUuidV7)).toBe(true);

      const verification = {
        outcome: 'VERIFIED' as const,
        decisionId: createOpaqueId(),
        identityId,
        methodClass: 'SYNTHETIC_ATTESTATION',
        resultCode: 'VERIFIED_SYNTHETIC',
        policyVersion: 'phase-one-test-v1',
        providerAlias: 'SYNTHETIC',
        evidenceType: 'SYNTHETIC_ATTESTATION',
        evidenceDigest: createHash('sha256').update('command-boundary-evidence').digest(),
        restrictedEvidenceReference: 'command-boundary-reference',
        retentionClass: 'SYNTHETIC_TEST_ONLY',
        actorReference: 'trusted-test-adapter',
        correlationId: createOpaqueId(),
      };
      await expect(runtimeService.recordTrustedVerification(verification)).rejects.toMatchObject({
        code: '42501',
      });

      // P1-AUD-001: the runtime cannot manufacture any link of the establishment chain.
      const caseId = createOpaqueId();
      const evidenceId = createOpaqueId();
      const forgeries: readonly (readonly [string, readonly unknown[]])[] = [
        [
          `INSERT INTO identity.verification_cases (
             id, identity_id, method_class, status, policy_version, opened_at, expires_at
           ) VALUES ($1, $2, 'SYNTHETIC_AUDIT', 'PENDING', 'phase-one-audit-v1',
             clock_timestamp(), clock_timestamp() + interval '15 minutes')`,
          [caseId, identityId],
        ],
        [
          `INSERT INTO identity.verification_evidence (
             id, case_id, evidence_type, provider_alias, collected_at, digest_algorithm,
             evidence_digest, restricted_reference, retention_class, created_at
           ) VALUES ($1, $2, 'SYNTHETIC_ATTESTATION', 'SYNTHETIC', clock_timestamp(), 'sha-256',
             $3, 'forged-reference', 'SYNTHETIC_TEST_ONLY', clock_timestamp())`,
          [evidenceId, caseId, createHash('sha256').update('forged').digest()],
        ],
        [
          `INSERT INTO identity.identity_reviews (
             id, case_id, state, actor_class, actor_reference, reason_code,
             evidence_reference, policy_version, created_at, updated_at, resolved_at
           ) VALUES ($1, $2, 'NOT_REQUIRED', 'POLICY_ENGINE', 'runtime-manufactured',
             'TRUSTED_VERIFICATION_ACCEPTED', $3, 'phase-one-audit-v1',
             clock_timestamp(), clock_timestamp(), clock_timestamp())`,
          [createOpaqueId(), caseId, evidenceId],
        ],
        [
          `UPDATE identity.document_fingerprint_claims claim
           SET state = 'BOUND', bound_at = clock_timestamp()
           FROM identity.identity_documents document
           WHERE claim.document_id = document.id AND document.identity_id = $1`,
          [identityId],
        ],
        [
          `INSERT INTO identity.identity_status_transitions (
             id, identity_id, from_status, to_status, aggregate_version,
             actor_class, actor_reference, reason_code, evidence_reference, occurred_at
           ) VALUES ($1, $2, 'PENDING', 'ESTABLISHED', 1, 'TRUSTED_VERIFICATION_HANDLER',
             'runtime-manufactured', 'IDENTITY_ESTABLISHED', $3, clock_timestamp())`,
          [createOpaqueId(), identityId, evidenceId],
        ],
        [
          `UPDATE identity.person_identities
           SET status = 'ESTABLISHED', status_reason_code = 'IDENTITY_ESTABLISHED',
               version = 1, updated_at = clock_timestamp(), established_at = clock_timestamp()
           WHERE id = $1`,
          [identityId],
        ],
        [
          `INSERT INTO accounts.account_status_transitions (
             id, account_id, from_status, to_status, aggregate_version,
             actor_class, actor_reference, reason_code, evidence_reference, occurred_at
           ) VALUES ($1, $2, 'PENDING_IDENTITY', 'ACTIVE', 1, 'TRUSTED_VERIFICATION_HANDLER',
             'runtime-manufactured', 'IDENTITY_ESTABLISHED', $3, clock_timestamp())`,
          [createOpaqueId(), accountId, evidenceId],
        ],
        [
          `UPDATE accounts.accounts
           SET status = 'ACTIVE', status_reason_code = 'IDENTITY_ESTABLISHED',
               version = 1, updated_at = clock_timestamp()
           WHERE id = $1`,
          [accountId],
        ],
      ];
      const client = await runtimePool.connect();
      try {
        for (const [statement, parameters] of forgeries) {
          await client.query('BEGIN');
          try {
            await expect(client.query(statement, [...parameters])).rejects.toMatchObject({
              code: '42501',
            });
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        client.release();
      }

      // P1-AUD-003: even the table owner cannot cite another case's evidence in a review.
      const owner = await pool.connect();
      try {
        await owner.query('BEGIN');
        const sourceCaseId = createOpaqueId();
        const targetCaseId = createOpaqueId();
        const sourceEvidenceId = createOpaqueId();
        for (const id of [sourceCaseId, targetCaseId]) {
          await owner.query(
            `INSERT INTO identity.verification_cases (
               id, identity_id, method_class, status, policy_version, opened_at, expires_at
             ) VALUES ($1, $2, 'SYNTHETIC_AUDIT', 'PENDING', 'phase-one-audit-v1',
               clock_timestamp(), clock_timestamp() + interval '15 minutes')`,
            [id, identityId],
          );
        }
        await owner.query(
          `INSERT INTO identity.verification_evidence (
             id, case_id, evidence_type, provider_alias, collected_at, digest_algorithm,
             evidence_digest, restricted_reference, retention_class, created_at
           ) VALUES ($1, $2, 'SYNTHETIC_ATTESTATION', 'SYNTHETIC', clock_timestamp(), 'sha-256',
             $3, 'source-reference', 'SYNTHETIC_TEST_ONLY', clock_timestamp())`,
          [sourceEvidenceId, sourceCaseId, createHash('sha256').update('source').digest()],
        );
        await expect(
          owner.query(
            `INSERT INTO identity.identity_reviews (
               id, case_id, state, actor_class, actor_reference, reason_code,
               evidence_reference, policy_version, created_at, updated_at, resolved_at
             ) VALUES ($1, $2, 'NOT_REQUIRED', 'POLICY_ENGINE', 'cross-case',
               'TRUSTED_VERIFICATION_ACCEPTED', $3, 'phase-one-audit-v1',
               clock_timestamp(), clock_timestamp(), clock_timestamp())`,
            [createOpaqueId(), targetCaseId, sourceEvidenceId],
          ),
        ).rejects.toMatchObject({ constraint: 'identity_review_evidence_same_case' });
      } finally {
        await owner.query('ROLLBACK');
        owner.release();
      }

      // The verification workload establishes and activates with its outbox in one command.
      const verifierService = serviceOn(verifierPool);
      await expect(verifierService.recordTrustedVerification(verification)).resolves.toBe(
        'RECORDED',
      );
      await expect(verifierService.recordTrustedVerification(verification)).resolves.toBe('REPLAY');
      await expect(
        verifierService.recordTrustedVerification({
          ...verification,
          identityId: createOpaqueId(),
        }),
      ).rejects.toThrow('VERIFICATION_DECISION_REUSE');
      const activation = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM platform.outbox_events
         WHERE aggregate_id IN ($1, $2)
           AND event_type IN ('identity.established', 'account.activated')
         ORDER BY event_type`,
        [accountId, identityId],
      );
      expect(activation.rows.map((row) => row.event_type)).toEqual([
        'account.activated',
        'identity.established',
      ]);
      const state = await pool.query<{ status: string }>(
        'SELECT status FROM accounts.accounts WHERE id = $1',
        [accountId],
      );
      expect(state.rows[0]?.status).toBe('ACTIVE');
      await expect(
        verifierPool.query('SELECT id FROM accounts.accounts LIMIT 1'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtimePool.end();
      await verifierPool.end();
      await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, runtime.name);
      await dropRestrictedRuntimeLogin(
        adminConfig.databaseUrl,
        verifier.name,
        'trayvi_verification',
      );
    }
  });

  it('grants the rotation workload only its narrow privileges', async () => {
    const client = await rotation().connect();
    const denied = async (statement: string): Promise<boolean> => {
      await client.query('BEGIN');
      try {
        await client.query(statement);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        return false;
      } catch {
        return true;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      await expect(
        client.query(
          'SELECT fingerprint, hmac_key_version FROM identity.document_fingerprint_claims LIMIT 1',
        ),
      ).resolves.toBeDefined();
      const statements = [
        'SELECT id FROM accounts.accounts LIMIT 1',
        'SELECT id FROM identity.person_identities LIMIT 1',
        `UPDATE identity.identity_documents SET ciphertext = decode('00', 'hex')`,
        `UPDATE identity.identity_documents SET state = 'REVOKED'`,
        `UPDATE identity.document_fingerprint_claims SET fingerprint = decode('00', 'hex')`,
        'DELETE FROM identity.document_fingerprint_claims',
        'SELECT id FROM identity.verification_evidence LIMIT 1',
        'CREATE TABLE identity.rotation_bypass (id integer)',
        'SET ROLE trayvi_migrator',
        `SELECT identity.record_trusted_verification(
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ];
      const results: boolean[] = [];
      for (const statement of statements) results.push(await denied(statement));
      expect(results).toEqual(statements.map(() => true));
    } finally {
      client.release();
    }

    const runtime = await createRestrictedRuntimeLogin(adminConfig.databaseUrl, database.url);
    const runtimeClient = new Client({ connectionString: runtime.url });
    await runtimeClient.connect();
    try {
      await expect(
        runtimeClient.query(
          `SELECT identity.set_fingerprint_key_policy(ARRAY['fingerprint-v2']::varchar[])`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await runtimeClient.end();
      await dropRestrictedRuntimeLogin(adminConfig.databaseUrl, runtime.name);
    }
  });

  it('refuses destructive migration rollback while Phase 1 contains data', async () => {
    await expect(migrator.down()).rejects.toThrow('rolled back');
    expect((await migrator.status()).at(-1)?.version).toBe('0010');
  });

  it('runs the Phase 1 clean up/down/up cycle without changing prior migrations', async () => {
    const cleanDatabase = await createDisposableDatabase(
      adminConfig.databaseUrl,
      'trayvi_phase_one_cycle',
    );
    const cleanMigrator = new SqlMigrator(cleanDatabase.url);
    try {
      expect((await cleanMigrator.up()).applied).toHaveLength(10);
      expect((await cleanMigrator.up()).skipped).toHaveLength(10);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect(await cleanMigrator.down()).toHaveLength(1);
      expect((await cleanMigrator.status()).map((entry) => entry.version)).toEqual([
        '0001',
        '0002',
        '0003',
        '0004',
      ]);
      expect((await cleanMigrator.up()).applied).toEqual([
        '0005',
        '0006',
        '0007',
        '0008',
        '0009',
        '0010',
      ]);
    } finally {
      await cleanMigrator.close();
      await delay(25);
      await dropDisposableDatabase(adminConfig.databaseUrl, cleanDatabase.name);
    }
  });
});
