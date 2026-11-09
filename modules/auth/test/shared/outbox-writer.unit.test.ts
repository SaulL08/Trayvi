import { describe, expect, it } from 'vitest';

import type { AuthOutboxEvent } from '../../src/contracts/outbox';
import type { SqlExecutor } from '../../src/contracts/runtime';
import {
  AUTH_EVENT_PAYLOAD_FIELDS,
  OutboxPayloadError,
  PostgresOutboxWriter,
} from '../../src/infrastructure/shared/outbox-writer';

function recordingExecutor(): SqlExecutor & { readonly calls: (readonly unknown[])[] } {
  const calls: (readonly unknown[])[] = [];
  return {
    calls,
    query: <Row extends object>(_text: string, values: readonly unknown[]) => {
      calls.push(values);
      return Promise.resolve({ rows: [] as Row[], rowCount: 1 });
    },
  };
}

const bound: AuthOutboxEvent = {
  id: '018f0000-0000-7000-8000-0000000000c1',
  type: 'auth.contact.bound',
  schemaVersion: 1,
  aggregateType: 'auth_contact',
  aggregateId: '018f0000-0000-7000-8000-0000000000b1',
  occurredAt: new Date('2026-11-03T00:00:00.000Z'),
  correlationId: '018f0000-0000-7000-8000-0000000000d1',
  payload: {
    contactId: '018f0000-0000-7000-8000-0000000000b1',
    accountId: '018f0000-0000-7000-8000-0000000000e1',
    reason: 'REGISTRATION',
  },
};

describe('PostgresOutboxWriter', () => {
  it('writes an allowlisted event inside the caller transaction', async () => {
    const sql = recordingExecutor();
    await new PostgresOutboxWriter().enqueue(sql, bound);
    expect(sql.calls).toHaveLength(1);
    const values = sql.calls[0] ?? [];
    expect(values[3]).toBe('auth_contact');
    expect(values[7]).toBeNull();
    expect(JSON.parse(String(values[8]))).toEqual(bound.payload);
  });

  it('rejects extra or missing payload fields before touching the database', async () => {
    const sql = recordingExecutor();
    const writer = new PostgresOutboxWriter();
    await expect(
      writer.enqueue(sql, { ...bound, payload: { ...bound.payload, phoneNumber: '+18095550100' } }),
    ).rejects.toBeInstanceOf(OutboxPayloadError);
    const missing = Object.fromEntries(
      Object.entries(bound.payload).filter(([field]) => field !== 'reason'),
    );
    await expect(writer.enqueue(sql, { ...bound, payload: missing })).rejects.toBeInstanceOf(
      OutboxPayloadError,
    );
    expect(sql.calls).toHaveLength(0);
  });

  it('uses aggregate types accepted by the Phase 0 outbox format check', () => {
    const aggregateTypes: AuthOutboxEvent['aggregateType'][] = [
      'auth_contact',
      'auth_challenge',
      'auth_session',
      'auth_credential',
    ];
    for (const aggregateType of aggregateTypes) {
      expect(aggregateType).toMatch(/^[a-z][a-z0-9_]{0,99}$/u);
    }
  });

  it('allowlists exactly the SPEC-002 design §2.3 session and credential payloads', async () => {
    expect({
      'auth.session.created': AUTH_EVENT_PAYLOAD_FIELDS['auth.session.created'],
      'auth.session.family-revoked': AUTH_EVENT_PAYLOAD_FIELDS['auth.session.family-revoked'],
      'auth.session.reuse-detected': AUTH_EVENT_PAYLOAD_FIELDS['auth.session.reuse-detected'],
      'auth.password.changed': AUTH_EVENT_PAYLOAD_FIELDS['auth.password.changed'],
    }).toEqual({
      'auth.session.created': ['familyId', 'accountId', 'assurance', 'newInstallation'],
      'auth.session.family-revoked': ['familyId', 'accountId', 'reason'],
      'auth.session.reuse-detected': ['familyId', 'accountId'],
      'auth.password.changed': ['accountId', 'change'],
    });
    const sql = recordingExecutor();
    await new PostgresOutboxWriter().enqueue(sql, {
      ...bound,
      type: 'auth.session.created',
      aggregateType: 'auth_session',
      payload: {
        familyId: '018f0000-0000-7000-8000-0000000000f1',
        accountId: '018f0000-0000-7000-8000-0000000000e1',
        assurance: 'AAL1',
        newInstallation: true,
      },
    });
    expect(sql.calls[0]?.[3]).toBe('auth_session');
  });
});
