import type { SqlExecutor } from './runtime';

export type AuthEventType =
  | 'auth.contact.bound'
  | 'auth.contact.replaced'
  | 'auth.contact.revoked'
  // SPEC-002 design §2.3
  | 'auth.session.created'
  | 'auth.session.family_revoked'
  | 'auth.session.reuse_detected'
  | 'auth.password.changed';

export interface AuthOutboxEvent {
  readonly id: string;
  readonly type: AuthEventType;
  readonly schemaVersion: 1;
  // outbox_aggregate_type_format forbids '.'
  readonly aggregateType: 'auth_contact' | 'auth_challenge' | 'auth_session' | 'auth_credential';
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

export interface OutboxWriter {
  enqueue(sql: SqlExecutor, event: AuthOutboxEvent): Promise<void>;
}
