import type { SqlExecutor } from './runtime';

export type AuthEventType = 'auth.contact.bound' | 'auth.contact.replaced' | 'auth.contact.revoked';

export interface AuthOutboxEvent {
  readonly id: string;
  readonly type: AuthEventType;
  readonly schemaVersion: 1;
  readonly aggregateType: 'auth_contact' | 'auth_challenge'; // outbox_aggregate_type_format forbids '.'
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

export interface OutboxWriter {
  enqueue(sql: SqlExecutor, event: AuthOutboxEvent): Promise<void>;
}
