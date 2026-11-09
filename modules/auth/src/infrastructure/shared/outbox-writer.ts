import type { AuthEventType, AuthOutboxEvent, OutboxWriter } from '../../contracts/outbox';
import type { SqlExecutor } from '../../contracts/runtime';

/**
 * SPEC-001 and SPEC-002 design §2.3 payload allowlists. Every listed field is required; no other
 * is allowed.
 */
export const AUTH_EVENT_PAYLOAD_FIELDS: Readonly<Record<AuthEventType, readonly string[]>> = {
  'auth.contact.bound': ['contactId', 'accountId', 'reason'],
  'auth.contact.replaced': ['contactId', 'previousContactId', 'accountId', 'reason', 'caseId'],
  'auth.contact.revoked': ['contactId', 'accountId', 'reason'],
  'auth.session.created': ['familyId', 'accountId', 'assurance', 'newInstallation'],
  'auth.session.family_revoked': ['familyId', 'accountId', 'reason'],
  'auth.session.reuse_detected': ['familyId', 'accountId'],
  'auth.password.changed': ['accountId', 'change'],
};

export class OutboxPayloadError extends Error {
  constructor() {
    super('OUTBOX_PAYLOAD_NOT_ALLOWLISTED');
    this.name = 'OutboxPayloadError';
  }
}

function assertAllowlisted(event: AuthOutboxEvent): void {
  const allowed = AUTH_EVENT_PAYLOAD_FIELDS[event.type] as readonly string[] | undefined;
  if (!allowed) throw new OutboxPayloadError();
  const keys = Object.keys(event.payload).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new OutboxPayloadError();
  }
}

/** Inserts into platform.outbox_events inside the caller's transaction (ADR-008). */
export class PostgresOutboxWriter implements OutboxWriter {
  async enqueue(sql: SqlExecutor, event: AuthOutboxEvent): Promise<void> {
    assertAllowlisted(event);
    await sql.query(
      `INSERT INTO platform.outbox_events (
         id, event_type, schema_version, aggregate_type, aggregate_id,
         occurred_at, correlation_id, causation_id, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.id,
        event.type,
        event.schemaVersion,
        event.aggregateType,
        event.aggregateId,
        event.occurredAt,
        event.correlationId,
        event.causationId ?? null,
        JSON.stringify(event.payload),
      ],
    );
  }
}
