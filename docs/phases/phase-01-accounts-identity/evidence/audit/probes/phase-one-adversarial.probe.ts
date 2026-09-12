import { createHash } from 'node:crypto';

import { Client, Pool } from 'pg';

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

import { PhaseOneEnrollmentService } from '../../../../../../apps/api/src/phase-01/phase-one-enrollment';
import { PostgresPhaseOneStore } from '../../../../../../apps/api/src/phase-01/postgres-phase-one-store';
import { SqlMigrator } from '../../../../../../scripts/db/migrate';

const fingerprintV1 = Buffer.alloc(32, 11);
const fingerprintV2 = Buffer.alloc(32, 22);
const kek = Buffer.alloc(32, 33);
const idempotencyKey = Buffer.alloc(32, 44);

interface AggregateIds {
  readonly accountId: string;
  readonly identityId: string;
}

interface StateCount {
  readonly state: string;
  readonly count: string;
}

function protector(
  versions: readonly {
    readonly version: string;
    readonly key: Buffer;
    readonly state: 'PRIMARY' | 'LOOKUP_ACTIVE';
  }[],
): NodeIdentityDocumentProtector {
  return new NodeIdentityDocumentProtector(
    new ConfiguredFingerprintKeyring(versions),
    new SyntheticAesGcmKeyEncryptionProvider('kek-audit-v1', new Map([['kek-audit-v1', kek]])),
    new NodeKeyedRequestCommitter('idempotency-audit-v1', idempotencyKey),
  );
}

function service(
  pool: Pool,
  documentProtector: NodeIdentityDocumentProtector,
): PhaseOneEnrollmentService {
  return new PhaseOneEnrollmentService(
    new PostgresPhaseOneStore(pool),
    documentProtector,
    createOpaqueId,
    () => new Date(),
  );
}

async function start(enrollment: PhaseOneEnrollmentService, suffix: string): Promise<string> {
  const result = await enrollment.startAccountCreation({
    callerBinding: `audit-caller-${suffix}`,
    idempotencyKey: `audit-start-${suffix}`,
    channel: 'AUDIT',
    locale: 'es-DO',
  });
  return result.operationId;
}

async function seedPending(
  pool: Pool,
  enrollment: PhaseOneEnrollmentService,
  suffix: string,
  documentValue: string,
): Promise<AggregateIds> {
  const operationId = await start(enrollment, suffix);
  await enrollment.submitIdentityInformation({
    operationId,
    documentValue,
    correlationId: createOpaqueId(),
  });
  const result = await pool.query<{ account_id: string; identity_id: string }>(
    `SELECT operation.account_id, person_identity.id AS identity_id
     FROM accounts.account_creation_operations operation
     JOIN identity.person_identities person_identity
       ON person_identity.account_id = operation.account_id
     WHERE operation.id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('AUDIT_SEED_FAILED');
  return { accountId: row.account_id, identityId: row.identity_id };
}

async function forgeActivation(
  runtime: Client,
  aggregate: AggregateIds,
  caseId: string,
  evidenceId: string,
): Promise<void> {
  const occurredAt = new Date();
  await runtime.query(
    `UPDATE identity.document_fingerprint_claims claim
     SET state = 'BOUND', bound_at = $2
     FROM identity.identity_documents document
     WHERE claim.document_id = document.id
       AND document.identity_id = $1
       AND claim.state = 'RESERVED'`,
    [aggregate.identityId, occurredAt],
  );
  await runtime.query(
    `INSERT INTO identity.identity_status_transitions (
       id, identity_id, from_status, to_status, aggregate_version,
       actor_class, actor_reference, reason_code, evidence_reference, occurred_at
     ) VALUES ($1, $2, 'PENDING', 'ESTABLISHED', 1,
       'TRUSTED_VERIFICATION_HANDLER', 'runtime-manufactured',
       'IDENTITY_ESTABLISHED', $3, $4)`,
    [createOpaqueId(), aggregate.identityId, evidenceId, occurredAt],
  );
  await runtime.query(
    `UPDATE identity.person_identities
     SET status = 'ESTABLISHED', status_reason_code = 'IDENTITY_ESTABLISHED',
         version = 1, updated_at = $2, established_at = $2
     WHERE id = $1 AND status = 'PENDING' AND version = 0`,
    [aggregate.identityId, occurredAt],
  );
  await runtime.query(
    `INSERT INTO accounts.account_status_transitions (
       id, account_id, from_status, to_status, aggregate_version,
       actor_class, actor_reference, reason_code, evidence_reference, occurred_at
     ) VALUES ($1, $2, 'PENDING_IDENTITY', 'ACTIVE', 1,
       'TRUSTED_VERIFICATION_HANDLER', 'runtime-manufactured',
       'IDENTITY_ESTABLISHED', $3, $4)`,
    [createOpaqueId(), aggregate.accountId, evidenceId, occurredAt],
  );
  await runtime.query(
    `UPDATE accounts.accounts
     SET status = 'ACTIVE', status_reason_code = 'IDENTITY_ESTABLISHED',
         version = 1, updated_at = $2
     WHERE id = $1 AND status = 'PENDING_IDENTITY' AND version = 0`,
    [aggregate.accountId, occurredAt],
  );
  await runtime.query('SET CONSTRAINTS ALL IMMEDIATE');
  void caseId;
}

async function insertVerificationChain(
  runtime: Client,
  identityId: string,
  caseId: string,
  evidenceId: string,
  evidenceCaseId = caseId,
): Promise<void> {
  const occurredAt = new Date();
  await runtime.query(
    `INSERT INTO identity.verification_cases (
       id, identity_id, method_class, status, policy_version, opened_at, expires_at
     ) VALUES ($1, $2, 'SYNTHETIC_AUDIT', 'PENDING', 'phase-one-audit-v1', $3, $4)`,
    [caseId, identityId, occurredAt, new Date(occurredAt.getTime() + 900_000)],
  );
  if (evidenceCaseId === caseId) {
    await runtime.query(
      `INSERT INTO identity.verification_evidence (
         id, case_id, evidence_type, provider_alias, collected_at, digest_algorithm,
         evidence_digest, restricted_reference, retention_class, created_at
       ) VALUES ($1, $2, 'SYNTHETIC_ATTESTATION', 'SYNTHETIC', $3, 'sha-256',
         $4, 'synthetic-audit-reference', 'SYNTHETIC_TEST_ONLY', $3)`,
      [
        evidenceId,
        evidenceCaseId,
        occurredAt,
        createHash('sha256').update('synthetic-audit-evidence').digest(),
      ],
    );
  }
  await runtime.query(
    `INSERT INTO identity.identity_reviews (
       id, case_id, state, actor_class, actor_reference, reason_code,
       evidence_reference, policy_version, created_at, updated_at, resolved_at
     ) VALUES ($1, $2, 'NOT_REQUIRED', 'POLICY_ENGINE', 'runtime-manufactured',
       'TRUSTED_VERIFICATION_ACCEPTED', $3, 'phase-one-audit-v1', $4, $4, $4)`,
    [createOpaqueId(), caseId, evidenceId, occurredAt],
  );
  await runtime.query(
    `UPDATE identity.verification_cases
     SET decision_id = $2, status = 'VERIFIED', result_code = 'VERIFIED_SYNTHETIC',
         resolved_at = $3
     WHERE id = $1`,
    [caseId, createOpaqueId(), occurredAt],
  );
}

async function stateCounts(
  pool: Pool,
  operationIds: readonly string[],
): Promise<Record<string, number>> {
  const result = await pool.query<StateCount>(
    `SELECT state, count(*)::text AS count
     FROM accounts.account_creation_operations
     WHERE id = ANY($1::uuid[])
     GROUP BY state`,
    [operationIds],
  );
  return Object.fromEntries(result.rows.map((row) => [row.state, Number(row.count)]));
}

async function attemptDenied(client: Client, statement: string): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await client.query(statement);
    return false;
  } catch {
    return true;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main(): Promise<void> {
  const adminUrl = process.env['MIGRATION_DATABASE_URL'];
  if (!adminUrl) throw new Error('MIGRATION_DATABASE_URL_REQUIRED');
  await ensureDatabaseBootstrap(adminUrl);
  const database = await createDisposableDatabase(adminUrl, 'trayvi_phase_one_audit');
  const migrator = new SqlMigrator(database.url);
  let pool: Pool | undefined;
  let runtimeLogin: Awaited<ReturnType<typeof createRestrictedRuntimeLogin>> | undefined;
  let runtime: Client | undefined;
  try {
    await migrator.up();
    pool = new Pool({ connectionString: database.url, max: 80, statement_timeout: 60_000 });
    const v1 = service(
      pool,
      protector([{ version: 'fingerprint-audit-v1', key: fingerprintV1, state: 'PRIMARY' }]),
    );
    const v2 = service(
      pool,
      protector([{ version: 'fingerprint-audit-v2', key: fingerprintV2, state: 'PRIMARY' }]),
    );

    runtimeLogin = await createRestrictedRuntimeLogin(adminUrl, database.url);
    runtime = new Client({ connectionString: runtimeLogin.url });
    await runtime.connect();

    const runtimeAggregate = await seedPending(pool, v1, 'runtime-forgery', '52000000001');
    const runtimeCaseId = createOpaqueId();
    const runtimeEvidenceId = createOpaqueId();
    const activationEventsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_events
       WHERE aggregate_id IN ($1, $2)
         AND event_type IN ('identity.established', 'account.activated')`,
      [runtimeAggregate.accountId, runtimeAggregate.identityId],
    );
    let manufacturedActivationCommitted = false;
    await runtime.query('BEGIN');
    try {
      await insertVerificationChain(
        runtime,
        runtimeAggregate.identityId,
        runtimeCaseId,
        runtimeEvidenceId,
      );
      await forgeActivation(runtime, runtimeAggregate, runtimeCaseId, runtimeEvidenceId);
      await runtime.query('COMMIT');
      manufacturedActivationCommitted = true;
    } catch (error: unknown) {
      await runtime.query('ROLLBACK');
      if (!(error instanceof Error)) throw error;
    }
    const manufacturedState = await pool.query<{
      account_status: string;
      identity_status: string;
      claim_state: string;
    }>(
      `SELECT account.status AS account_status, person_identity.status AS identity_status,
              claim.state AS claim_state
       FROM accounts.accounts account
       JOIN identity.person_identities person_identity ON person_identity.account_id = account.id
       JOIN identity.identity_documents document ON document.identity_id = person_identity.id
       JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
       WHERE account.id = $1`,
      [runtimeAggregate.accountId],
    );
    const activationEventsAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_events
       WHERE aggregate_id IN ($1, $2)
         AND event_type IN ('identity.established', 'account.activated')`,
      [runtimeAggregate.accountId, runtimeAggregate.identityId],
    );

    const crossTarget = await seedPending(pool, v1, 'cross-case-target', '53000000001');
    const crossSource = await seedPending(pool, v1, 'cross-case-source', '54000000001');
    const targetCaseId = createOpaqueId();
    const sourceCaseId = createOpaqueId();
    const crossEvidenceId = createOpaqueId();
    let crossCaseActivationCommitted = false;
    await runtime.query('BEGIN');
    try {
      const occurredAt = new Date();
      await runtime.query(
        `INSERT INTO identity.verification_cases (
           id, identity_id, method_class, status, policy_version, opened_at, expires_at
         ) VALUES ($1, $2, 'SYNTHETIC_AUDIT', 'PENDING', 'phase-one-audit-v1', $3, $4)`,
        [
          sourceCaseId,
          crossSource.identityId,
          occurredAt,
          new Date(occurredAt.getTime() + 900_000),
        ],
      );
      await runtime.query(
        `INSERT INTO identity.verification_evidence (
           id, case_id, evidence_type, provider_alias, collected_at, digest_algorithm,
           evidence_digest, restricted_reference, retention_class, created_at
         ) VALUES ($1, $2, 'SYNTHETIC_ATTESTATION', 'SYNTHETIC', $3, 'sha-256',
           $4, 'synthetic-cross-case-reference', 'SYNTHETIC_TEST_ONLY', $3)`,
        [
          crossEvidenceId,
          sourceCaseId,
          occurredAt,
          createHash('sha256').update('synthetic-cross-case-evidence').digest(),
        ],
      );
      await insertVerificationChain(
        runtime,
        crossTarget.identityId,
        targetCaseId,
        crossEvidenceId,
        sourceCaseId,
      );
      await forgeActivation(runtime, crossTarget, targetCaseId, crossEvidenceId);
      await runtime.query('COMMIT');
      crossCaseActivationCommitted = true;
    } catch (error: unknown) {
      await runtime.query('ROLLBACK');
      if (!(error instanceof Error)) throw error;
    }
    const crossCaseLink = await pool.query<{
      review_case_id: string;
      evidence_case_id: string;
      account_status: string;
    }>(
      `SELECT review.case_id AS review_case_id, evidence.case_id AS evidence_case_id,
              account.status AS account_status
       FROM identity.identity_reviews review
       JOIN identity.verification_evidence evidence ON evidence.id = review.evidence_reference
       JOIN identity.verification_cases verification_case ON verification_case.id = review.case_id
       JOIN identity.person_identities person_identity
         ON person_identity.id = verification_case.identity_id
       JOIN accounts.accounts account ON account.id = person_identity.account_id
       WHERE review.case_id = $1`,
      [targetCaseId],
    );

    const privilegeChecks = {
      restrictedCiphertextReadDenied: await attemptDenied(
        runtime,
        'SELECT ciphertext FROM identity.identity_documents LIMIT 1',
      ),
      restrictedFingerprintReadDenied: await attemptDenied(
        runtime,
        'SELECT fingerprint FROM identity.document_fingerprint_claims LIMIT 1',
      ),
      documentRewrapUpdateDenied: await attemptDenied(
        runtime,
        `UPDATE identity.identity_documents
         SET kek_key_version = 'kek-audit-v2'
         WHERE false`,
      ),
      ddlDenied: await attemptDenied(
        runtime,
        'CREATE TABLE accounts.runtime_audit_probe (id integer)',
      ),
      roleEscalationDenied: await attemptDenied(runtime, 'SET ROLE trayvi_migrator'),
    };
    const roleCatalog = await pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles
       WHERE rolname LIKE 'trayvi_%'
       ORDER BY rolname`,
    );
    const searchPath = await runtime.query<{ search_path: string }>('SHOW search_path');

    await runtime.end();
    runtime = undefined;
    await dropRestrictedRuntimeLogin(adminUrl, runtimeLogin.name);
    runtimeLogin = undefined;

    const alignedOperations = await Promise.all(
      Array.from({ length: 120 }, (_, index) => start(v1, `aligned-${index}`)),
    );
    await Promise.all(
      alignedOperations.map((operationId) =>
        v1.submitIdentityInformation({
          operationId,
          documentValue: '55000000001',
          correlationId: createOpaqueId(),
        }),
      ),
    );
    const alignedStates = await stateCounts(pool, alignedOperations);

    const replayOperation = await start(v1, 'same-operation-replay');
    await Promise.all(
      Array.from({ length: 120 }, () =>
        v1.submitIdentityInformation({
          operationId: replayOperation,
          documentValue: '56000000001',
          correlationId: createOpaqueId(),
        }),
      ),
    );
    const replayAggregateCount = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT account_id)::text AS count
       FROM accounts.account_creation_operations
       WHERE id = $1 AND state = 'COMPLETED'`,
      [replayOperation],
    );

    const splitOperations = await Promise.all(
      Array.from({ length: 120 }, (_, index) => start(index % 2 === 0 ? v1 : v2, `split-${index}`)),
    );
    await Promise.all(
      splitOperations.map((operationId, index) =>
        (index % 2 === 0 ? v1 : v2).submitIdentityInformation({
          operationId,
          documentValue: '57000000001',
          correlationId: createOpaqueId(),
        }),
      ),
    );
    const splitStates = await stateCounts(pool, splitOperations);
    const splitWinners = await pool.query<{
      account_id: string;
      identity_id: string;
      hmac_key_version: string;
    }>(
      `SELECT account.id AS account_id, person_identity.id AS identity_id, claim.hmac_key_version
       FROM accounts.account_creation_operations operation
       JOIN accounts.accounts account ON account.id = operation.account_id
       JOIN identity.person_identities person_identity ON person_identity.account_id = account.id
       JOIN identity.identity_documents document ON document.identity_id = person_identity.id
       JOIN identity.document_fingerprint_claims claim ON claim.document_id = document.id
       WHERE operation.id = ANY($1::uuid[]) AND operation.state = 'COMPLETED'
       ORDER BY claim.hmac_key_version`,
      [splitOperations],
    );

    let crossPurposeKeyReuseAccepted = false;
    try {
      const shared = Buffer.alloc(32, 77);
      const reused = new NodeIdentityDocumentProtector(
        new ConfiguredFingerprintKeyring([
          { version: 'shared-fingerprint-v1', key: shared, state: 'PRIMARY' },
        ]),
        new SyntheticAesGcmKeyEncryptionProvider(
          'shared-kek-v1',
          new Map([['shared-kek-v1', shared]]),
        ),
        new NodeKeyedRequestCommitter('shared-idempotency-v1', shared),
      );
      await reused.protect({
        documentId: createOpaqueId(),
        identityId: createOpaqueId(),
        countryCode: 'DO',
        issuerCode: 'JCE',
        documentType: 'NATIONAL_ID',
        documentValue: '58000000001',
      });
      crossPurposeKeyReuseAccepted = true;
    } catch {
      crossPurposeKeyReuseAccepted = false;
    }

    const results = {
      schemaVersion: 1,
      syntheticDataOnly: true,
      runtimeManufacturedLifecycle: {
        committed: manufacturedActivationCommitted,
        resultingState: manufacturedState.rows[0] ?? null,
        activationOutboxEventsBefore: Number(activationEventsBefore.rows[0]?.count ?? '-1'),
        activationOutboxEventsAfter: Number(activationEventsAfter.rows[0]?.count ?? '-1'),
      },
      crossCaseEvidence: {
        committed: crossCaseActivationCommitted,
        reviewCaseDiffersFromEvidenceCase:
          crossCaseLink.rows[0]?.review_case_id !== crossCaseLink.rows[0]?.evidence_case_id,
        resultingAccountStatus: crossCaseLink.rows[0]?.account_status ?? null,
      },
      privileges: {
        ...privilegeChecks,
        roles: roleCatalog.rows.map((row) => row.rolname),
        runtimeSearchPath: searchPath.rows[0]?.search_path ?? null,
        dedicatedRotationRolePresent: roleCatalog.rows.some((row) =>
          /rotation|worker/u.test(row.rolname),
        ),
      },
      concurrency: {
        alignedKeySet: { attempts: 120, states: alignedStates },
        sameOperationReplay: {
          attempts: 120,
          completedAggregateCount: Number(replayAggregateCount.rows[0]?.count ?? '-1'),
        },
        disjointRotationKeySets: {
          attempts: 120,
          states: splitStates,
          winnerCount: splitWinners.rows.length,
          winnerKeyVersions: splitWinners.rows.map((row) => row.hmac_key_version),
        },
      },
      keyPurposeSeparation: {
        sameRawKeyAcceptedAcrossFingerprintKekAndIdempotency: crossPurposeKeyReuseAccepted,
      },
    };
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    if (runtime) await runtime.end().catch(() => undefined);
    if (pool) await closeInitializedDatabaseClients({ pool, migrator });
    else await migrator.close();
    if (runtimeLogin) {
      await dropRestrictedRuntimeLogin(adminUrl, runtimeLogin.name).catch(() => undefined);
    }
    await dropDisposableDatabase(adminUrl, database.name).catch(() => undefined);
  }
}

await main();
