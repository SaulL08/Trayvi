import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionCommandError } from '../../src/infrastructure/session/postgres-sessions';

import { createSessionHarness, seconds, uuidV7, type SessionHarness } from './session-harness';

describe('session revocation and step-up on real PostgreSQL (SPEC-002 ws-a)', () => {
  let harness: SessionHarness;

  beforeAll(async () => {
    harness = await createSessionHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  const at = () => harness.clock.now();
  const active = async (accessToken: string) =>
    (await harness.sessions.resolve(accessToken, seconds(at(), 1))).kind === 'ACTIVE';
  const revokedEvents = async (accountId: string) =>
    (
      await harness.admin.query<{ payload: { familyId: string; reason: string } }>(
        `SELECT payload FROM platform.outbox_events
         WHERE event_type = 'auth.session.family_revoked' AND payload->>'accountId' = $1`,
        [accountId],
      )
    ).rows.map((row) => row.payload);

  it('revokes one family the account owns and reports NOT_FOUND otherwise (R-09)', async () => {
    const owner = await harness.createAccount();
    const other = await harness.createAccount();
    const mine = await harness.issue(owner);
    const theirs = await harness.issue(other);

    const revoke = (accountId: string, familyId: string) =>
      harness.transactions.inTransaction((sql) =>
        harness.sessions.revokeFamily(sql, {
          accountId,
          familyId,
          reason: 'USER_REVOKED',
          at: at(),
          correlationId: uuidV7.uuidV7(),
        }),
      );

    await expect(revoke(owner, theirs.familyId)).resolves.toEqual({ kind: 'NOT_FOUND' });
    await expect(revoke(owner, 'not-a-uuid')).resolves.toEqual({ kind: 'NOT_FOUND' });
    expect(await active(theirs.accessToken)).toBe(true);

    await expect(revoke(owner, mine.familyId)).resolves.toEqual({ kind: 'REVOKED' });
    expect(await active(mine.accessToken)).toBe(false);
    await expect(revoke(owner, mine.familyId)).resolves.toEqual({ kind: 'NOT_FOUND' });
    expect(await revokedEvents(owner)).toEqual([
      { familyId: mine.familyId, accountId: owner, reason: 'USER_REVOKED' },
    ]);
  });

  it('revokes every other family, keeping the current one (R-09)', async () => {
    const accountId = await harness.createAccount();
    const current = await harness.issue(accountId);
    const others = [await harness.issue(accountId), await harness.issue(accountId)];
    const revoked = await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeAllForAccount(sql, {
        accountId,
        exceptFamilyId: current.familyId,
        reason: 'USER_REVOKED',
        at: at(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    expect(revoked).toBe(2);
    expect(await active(current.accessToken)).toBe(true);
    for (const family of others) expect(await active(family.accessToken)).toBe(false);
  });

  it('revokes with the caller transaction: rollback keeps every family, commit ends them (R-10)', async () => {
    const accountId = await harness.createAccount();
    const families = [await harness.issue(accountId), await harness.issue(accountId)];

    await expect(
      harness.transactions.inTransaction(async (sql) => {
        const count = await harness.sessions.revokeAllForAccount(sql, {
          accountId,
          reason: 'RECOVERY',
          at: at(),
          correlationId: uuidV7.uuidV7(),
        });
        expect(count).toBe(2);
        throw new Error('caller change failed');
      }),
    ).rejects.toThrow('caller change failed');
    for (const family of families) expect(await active(family.accessToken)).toBe(true);
    expect(await revokedEvents(accountId)).toEqual([]);

    const count = await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeAllForAccount(sql, {
        accountId,
        reason: 'RECOVERY',
        at: at(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    expect(count).toBe(2);
    for (const family of families) {
      expect(await active(family.accessToken)).toBe(false);
      await expect(
        harness.sessions.refresh({
          refreshToken: family.refreshToken,
          installationCommitment: Buffer.alloc(32),
          at: seconds(at(), 1),
          correlationId: uuidV7.uuidV7(),
        }),
      ).resolves.toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
    }
    expect((await revokedEvents(accountId)).map((event) => event.reason)).toEqual([
      'RECOVERY',
      'RECOVERY',
    ]);
  });

  it('keeps REUSE_DETECTED for the rotation command and rejects bad identifiers', async () => {
    const accountId = await harness.createAccount();
    await expect(
      harness.transactions.inTransaction((sql) =>
        harness.sessions.revokeAllForAccount(sql, {
          accountId,
          reason: 'REUSE_DETECTED',
          at: at(),
          correlationId: uuidV7.uuidV7(),
        }),
      ),
    ).rejects.toEqual(new SessionCommandError('SESSION_COMMAND_INVALID'));
    await expect(
      harness.transactions.inTransaction((sql) =>
        harness.sessions.revokeAllForAccount(sql, {
          accountId,
          exceptFamilyId: 'x',
          reason: 'LOGOUT',
          at: at(),
          correlationId: uuidV7.uuidV7(),
        }),
      ),
    ).rejects.toEqual(new SessionCommandError('SESSION_COMMAND_INVALID'));
  });

  it('records a step-up on the same family, raising assurance with a password (R-24)', async () => {
    const accountId = await harness.createAccount();
    const issued = await harness.issue(accountId);
    const later = seconds(at(), 600);

    await harness.transactions.inTransaction((sql) =>
      harness.sessions.recordStepUp(sql, {
        familyId: issued.familyId,
        factor: 'CONTACT_OTP',
        at: later,
      }),
    );
    await expect(
      harness.sessions.resolve(issued.accessToken, seconds(at(), 1)),
    ).resolves.toMatchObject({
      kind: 'ACTIVE',
      familyId: issued.familyId,
      authenticatedAt: later,
      assurance: 'AAL1',
      factors: ['CONTACT_OTP'],
    });

    await harness.transactions.inTransaction((sql) =>
      harness.sessions.recordStepUp(sql, {
        familyId: issued.familyId,
        factor: 'PASSWORD',
        at: later,
      }),
    );
    await expect(
      harness.sessions.resolve(issued.accessToken, seconds(at(), 1)),
    ).resolves.toMatchObject({
      assurance: 'AAL2',
      factors: ['CONTACT_OTP', 'PASSWORD'],
    });
    const families = await harness.admin.query<{ count: string }>(
      'SELECT count(*) FROM auth.session_families WHERE account_id = $1',
      [accountId],
    );
    expect(families.rows[0]?.count).toBe('1');

    await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeFamily(sql, {
        accountId,
        familyId: issued.familyId,
        reason: 'LOGOUT',
        at: at(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    await expect(
      harness.transactions.inTransaction((sql) =>
        harness.sessions.recordStepUp(sql, {
          familyId: issued.familyId,
          factor: 'CONTACT_OTP',
          at: later,
        }),
      ),
    ).rejects.toEqual(new SessionCommandError('SESSION_FAMILY_NOT_ACTIVE'));
  });

  it('lists only the account’s live families and marks the current one', async () => {
    const accountId = await harness.createAccount();
    const first = await harness.issue(accountId);
    const second = await harness.issue(accountId);
    const gone = await harness.issue(accountId);
    await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeFamily(sql, {
        accountId,
        familyId: gone.familyId,
        reason: 'LOGOUT',
        at: at(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    await harness.issue(await harness.createAccount());

    const listed = await harness.sessions.listFamilies(accountId, second.familyId);
    expect(listed.map((family) => [family.familyId, family.current]).sort()).toEqual(
      [
        [first.familyId, false],
        [second.familyId, true],
      ].sort(),
    );
    expect(listed[0]).toMatchObject({ assurance: 'AAL1', createdAt: at(), lastRotatedAt: at() });
    await expect(harness.sessions.listFamilies('nope', second.familyId)).resolves.toEqual([]);
  });
});
