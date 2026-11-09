import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionCommandError } from '../../src/infrastructure/session/postgres-sessions';

import {
  createSessionHarness,
  installation,
  POLICY,
  seconds,
  uuidV7,
  type SessionHarness,
} from './session-harness';

const sha256 = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

describe('session families on real PostgreSQL (SPEC-002 ws-a)', () => {
  let harness: SessionHarness;

  beforeAll(async () => {
    harness = await createSessionHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  const tokenRow = async (token: string) =>
    (
      await harness.admin.query<{
        id: string;
        state: string;
        predecessor_id: string | null;
        first_used_at: Date | null;
      }>(
        'SELECT id, state, predecessor_id, first_used_at FROM auth.refresh_tokens WHERE token_hash = $1',
        [sha256(token)],
      )
    ).rows[0];

  const family = async (familyId: string) =>
    (
      await harness.admin.query<{
        state: string;
        revoke_reason: string | null;
        idle_expires_at: Date;
        absolute_expires_at: Date;
        version: number;
      }>(
        `SELECT state, revoke_reason, idle_expires_at, absolute_expires_at, version
         FROM auth.session_families WHERE id = $1`,
        [familyId],
      )
    ).rows[0];

  const events = async (familyId: string) =>
    (
      await harness.admin.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM platform.outbox_events
         WHERE aggregate_type = 'auth_session' AND aggregate_id = $1 ORDER BY occurred_at, id`,
        [familyId],
      )
    ).rows;

  const refresh = (refreshToken: string, device: Buffer, at: Date) =>
    harness.sessions.refresh({
      refreshToken,
      installationCommitment: device,
      at,
      correlationId: uuidV7.uuidV7(),
    });

  it('issues one family, session, and ISSUED refresh token atomically with an allowlisted event (R-02, R-30)', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const issued = await harness.issue(accountId, device, ['CONTACT_OTP', 'PASSWORD']);
    const at = harness.clock.now();

    expect(issued.accessToken).toMatch(/^tva_/u);
    expect(issued.refreshToken).toMatch(/^tvr_/u);
    expect(issued.accessTokenExpiresAt).toEqual(seconds(at, POLICY.accessTokenSeconds));
    expect(issued.familyExpiresAt).toEqual(seconds(at, POLICY.idleSeconds));
    expect(issued.newInstallation).toBe(true);

    const rows = await harness.admin.query<{
      families: string;
      sessions: string;
      issued: string;
      factors: string[];
      assurance: string;
    }>(
      `SELECT (SELECT count(*) FROM auth.session_families WHERE id = $1) AS families,
              (SELECT count(*) FROM auth.sessions WHERE family_id = $1) AS sessions,
              (SELECT count(*) FROM auth.refresh_tokens WHERE family_id = $1 AND state = 'ISSUED') AS issued,
              (SELECT factors FROM auth.session_families WHERE id = $1) AS factors,
              (SELECT assurance FROM auth.session_families WHERE id = $1) AS assurance`,
      [issued.familyId],
    );
    expect(rows.rows[0]).toMatchObject({
      families: '1',
      sessions: '1',
      issued: '1',
      factors: ['CONTACT_OTP', 'PASSWORD'],
      assurance: 'AAL2',
    });
    expect(await events(issued.familyId)).toEqual([
      {
        event_type: 'auth.session.created',
        payload: { familyId: issued.familyId, accountId, assurance: 'AAL2', newInstallation: true },
      },
    ]);

    // The same installation is not new for this account; a different one is.
    expect((await harness.issue(accountId, device)).newInstallation).toBe(false);
    expect((await harness.issue(accountId, installation())).newInstallation).toBe(true);
  });

  it('stores no token value, only 32-byte hashes', async () => {
    const issued = await harness.issue(await harness.createAccount());
    const dump = await harness.admin.query<{ text: string }>(
      `SELECT concat_ws('|', s.*::text, r.*::text, f.*::text) AS text
       FROM auth.sessions s JOIN auth.refresh_tokens r ON r.family_id = s.family_id
       JOIN auth.session_families f ON f.id = s.family_id WHERE s.family_id = $1`,
      [issued.familyId],
    );
    const text = dump.rows.map((row) => row.text).join('\n');
    expect(text).not.toContain(issued.accessToken);
    expect(text).not.toContain(issued.refreshToken);
    expect(text).not.toContain(issued.accessToken.slice(4));
  });

  it('refuses to issue for a SUSPENDED or CLOSED account and writes nothing', async () => {
    for (const status of ['SUSPENDED', 'CLOSED']) {
      const accountId = await harness.createAccount();
      await harness.setAccountStatus(accountId, status);
      await expect(harness.issue(accountId)).rejects.toEqual(
        new SessionCommandError('SESSION_ACCOUNT_NOT_ELIGIBLE'),
      );
      const count = await harness.admin.query<{ count: string }>(
        'SELECT count(*) FROM auth.session_families WHERE account_id = $1',
        [accountId],
      );
      expect(count.rows[0]?.count).toBe('0');
    }
  });

  it('resolves an active access token and answers INVALID for every other case alike (R-03)', async () => {
    const accountId = await harness.createAccount();
    const issued = await harness.issue(accountId, installation(), ['CONTACT_OTP']);
    const at = harness.clock.now();

    await expect(harness.sessions.resolve(issued.accessToken, seconds(at, 1))).resolves.toEqual({
      kind: 'ACTIVE',
      accountId,
      sessionId: issued.sessionId,
      familyId: issued.familyId,
      authenticatedAt: at,
      assurance: 'AAL1',
      factors: ['CONTACT_OTP'],
    });

    const revoked = await harness.issue(accountId);
    await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeFamily(sql, {
        accountId,
        familyId: revoked.familyId,
        reason: 'LOGOUT',
        at,
        correlationId: uuidV7.uuidV7(),
      }),
    );

    const invalid = [
      await harness.sessions.resolve(issued.accessToken, seconds(at, POLICY.accessTokenSeconds)),
      await harness.sessions.resolve(revoked.accessToken, seconds(at, 1)),
      await harness.sessions.resolve(issued.refreshToken, seconds(at, 1)),
      await harness.sessions.resolve(`tva_${'A'.repeat(43)}`, seconds(at, 1)),
      await harness.sessions.resolve('tva_short', seconds(at, 1)),
      await harness.sessions.resolve(undefined, seconds(at, 1)),
    ];
    for (const resolution of invalid) expect(resolution).toEqual({ kind: 'INVALID' });
  });

  it('rotates an ISSUED token, extends idle expiry, and never extends absolute expiry (R-04)', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const issued = await harness.issue(accountId, device);
    const before = await family(issued.familyId);
    const later = seconds(harness.clock.now(), 3_600);

    const result = await refresh(issued.refreshToken, device, later);
    expect(result.kind).toBe('ROTATED');
    if (result.kind !== 'ROTATED') return;
    expect(result.session.familyId).toBe(issued.familyId);
    expect(result.session.newInstallation).toBe(false);
    expect(result.session.accessTokenExpiresAt).toEqual(seconds(later, POLICY.accessTokenSeconds));

    const after = await family(issued.familyId);
    expect(after?.idle_expires_at).toEqual(seconds(later, POLICY.idleSeconds));
    expect(after?.absolute_expires_at).toEqual(before?.absolute_expires_at);
    expect(after?.version).toBe((before?.version ?? 0) + 1);

    const old = await tokenRow(issued.refreshToken);
    const successor = await tokenRow(result.session.refreshToken);
    expect(old?.state).toBe('ROTATED');
    expect(successor).toMatchObject({
      state: 'ISSUED',
      predecessor_id: old?.id,
      first_used_at: null,
    });
    await expect(
      harness.sessions.resolve(result.session.accessToken, seconds(later, 1)),
    ).resolves.toMatchObject({ kind: 'ACTIVE' });

    // Idle expiry is capped by the absolute expiry near the end of the family's life.
    const start = harness.clock.now();
    const day = await refresh(result.session.refreshToken, device, seconds(start, 24 * 3_600));
    if (day.kind !== 'ROTATED') throw new Error('rotation expected');
    const late = await refresh(day.session.refreshToken, device, seconds(start, 40 * 3_600));
    expect(late.kind).toBe('ROTATED');
    if (late.kind === 'ROTATED') {
      expect(late.session.familyExpiresAt).toEqual(before?.absolute_expires_at);
      expect((await family(issued.familyId))?.idle_expires_at).toEqual(before?.absolute_expires_at);
    }
  });

  it('accepts a grace retry only when every PLAN §9.3 condition holds (R-05)', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const issued = await harness.issue(accountId, device);
    const at = seconds(harness.clock.now(), 60);
    const first = await refresh(issued.refreshToken, device, at);
    if (first.kind !== 'ROTATED') throw new Error('rotation expected');

    const retry = await refresh(
      issued.refreshToken,
      device,
      seconds(at, POLICY.rotationGraceSeconds),
    );
    expect(retry.kind).toBe('ROTATED');
    if (retry.kind !== 'ROTATED') return;
    expect((await family(issued.familyId))?.state).toBe('ACTIVE');
    expect((await tokenRow(first.session.refreshToken))?.state).toBe('REVOKED');
    expect((await tokenRow(retry.session.refreshToken))?.state).toBe('ISSUED');
    const issuedCount = await harness.admin.query<{ count: string }>(
      "SELECT count(*) FROM auth.refresh_tokens WHERE family_id = $1 AND state = 'ISSUED'",
      [issued.familyId],
    );
    expect(issuedCount.rows[0]?.count).toBe('1');
    expect((await events(issued.familyId)).map((event) => event.event_type)).toEqual([
      'auth.session.created',
    ]);
  });

  describe('treats every other presentation as reuse and revokes the family (R-06)', () => {
    const rotated = async () => {
      const accountId = await harness.createAccount();
      const device = installation();
      const issued = await harness.issue(accountId, device);
      const at = seconds(harness.clock.now(), 60);
      const next = await refresh(issued.refreshToken, device, at);
      if (next.kind !== 'ROTATED') throw new Error('rotation expected');
      return { accountId, device, issued, next: next.session, at };
    };

    const expectReuse = async (familyId: string, accountId: string) => {
      expect(await family(familyId)).toMatchObject({
        state: 'REVOKED',
        revoke_reason: 'REUSE_DETECTED',
      });
      const live = await harness.admin.query<{ count: string }>(
        `SELECT (SELECT count(*) FROM auth.refresh_tokens WHERE family_id = $1 AND state = 'ISSUED')
              + (SELECT count(*) FROM auth.sessions WHERE family_id = $1 AND state = 'ACTIVE') AS count`,
        [familyId],
      );
      expect(live.rows[0]?.count).toBe('0');
      // Both events share occurred_at, so compare them without relying on insertion order.
      const revocation = (await events(familyId)).filter(
        (event) => event.event_type !== 'auth.session.created',
      );
      expect(revocation).toHaveLength(2);
      expect(revocation).toEqual(
        expect.arrayContaining([
          { event_type: 'auth.session.reuse_detected', payload: { familyId, accountId } },
          {
            event_type: 'auth.session.family_revoked',
            payload: { familyId, accountId, reason: 'REUSE_DETECTED' },
          },
        ]),
      );
    };

    it('outside the grace window', async () => {
      const { accountId, device, issued, at } = await rotated();
      const result = await refresh(
        issued.refreshToken,
        device,
        seconds(at, POLICY.rotationGraceSeconds + 1),
      );
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });

    it('after the successor was used', async () => {
      const { accountId, device, issued, next, at } = await rotated();
      expect((await refresh(next.refreshToken, device, seconds(at, 1))).kind).toBe('ROTATED');
      const result = await refresh(issued.refreshToken, device, seconds(at, 2));
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });

    it('from a different installation', async () => {
      const { accountId, issued, at } = await rotated();
      const result = await refresh(issued.refreshToken, installation(), seconds(at, 1));
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });

    it('for a token that is not the immediate predecessor', async () => {
      const { accountId, device, issued, next, at } = await rotated();
      const third = await refresh(next.refreshToken, device, seconds(at, 1));
      expect(third.kind).toBe('ROTATED');
      const result = await refresh(issued.refreshToken, device, seconds(at, 2));
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });

    it('for an ISSUED token from a different installation', async () => {
      const accountId = await harness.createAccount();
      const issued = await harness.issue(accountId);
      const result = await refresh(
        issued.refreshToken,
        installation(),
        seconds(harness.clock.now(), 1),
      );
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });

    it('for a second grace retry of the same token', async () => {
      const { accountId, device, issued, at } = await rotated();
      expect((await refresh(issued.refreshToken, device, seconds(at, 1))).kind).toBe('ROTATED');
      const result = await refresh(issued.refreshToken, device, seconds(at, 2));
      expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
      await expectReuse(issued.familyId, accountId);
    });
  });

  it('answers tokens of a revoked family with REAUTHENTICATION_REQUIRED and changes nothing', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const issued = await harness.issue(accountId, device);
    await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeFamily(sql, {
        accountId,
        familyId: issued.familyId,
        reason: 'LOGOUT',
        at: harness.clock.now(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    const before = await family(issued.familyId);
    const result = await refresh(issued.refreshToken, device, seconds(harness.clock.now(), 1));
    expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
    expect(await family(issued.familyId)).toEqual(before);
    expect(await refresh(`tvr_${'B'.repeat(43)}`, device, seconds(harness.clock.now(), 1))).toEqual(
      { kind: 'REAUTHENTICATION_REQUIRED' },
    );
    expect(await refresh('not-a-token', device, harness.clock.now())).toEqual({
      kind: 'REAUTHENTICATION_REQUIRED',
    });
  });

  it('expires a family past its idle or absolute expiry on refresh', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const idle = await harness.issue(accountId, device);
    const result = await refresh(
      idle.refreshToken,
      device,
      seconds(harness.clock.now(), POLICY.idleSeconds),
    );
    expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
    expect((await family(idle.familyId))?.state).toBe('EXPIRED');
    expect(await events(idle.familyId)).toHaveLength(1);
  });

  it('revokes the family with ACCOUNT_STATE when the account is suspended', async () => {
    const accountId = await harness.createAccount();
    const device = installation();
    const issued = await harness.issue(accountId, device);
    await harness.setAccountStatus(accountId, 'SUSPENDED');
    const result = await refresh(issued.refreshToken, device, seconds(harness.clock.now(), 1));
    expect(result).toEqual({ kind: 'REAUTHENTICATION_REQUIRED' });
    expect(await family(issued.familyId)).toMatchObject({
      state: 'REVOKED',
      revoke_reason: 'ACCOUNT_STATE',
    });
    expect((await events(issued.familyId)).at(-1)).toEqual({
      event_type: 'auth.session.family_revoked',
      payload: { familyId: issued.familyId, accountId, reason: 'ACCOUNT_STATE' },
    });
  });

  it('denies the runtime every direct write and every hash read (R-07, R-32)', async () => {
    const issued = await harness.issue(await harness.createAccount());
    const statements = [
      `UPDATE auth.session_families SET state = 'ACTIVE' WHERE id = '${issued.familyId}'`,
      `UPDATE auth.refresh_tokens SET state = 'ISSUED' WHERE family_id = '${issued.familyId}'`,
      `UPDATE auth.sessions SET expires_at = now() WHERE family_id = '${issued.familyId}'`,
      `DELETE FROM auth.sessions WHERE family_id = '${issued.familyId}'`,
      `INSERT INTO auth.sessions (id, family_id, access_token_hash, issued_at, expires_at, state)
         VALUES ('${uuidV7.uuidV7()}', '${issued.familyId}', decode(repeat('00', 32), 'hex'), now(), now() + interval '1 minute', 'ACTIVE')`,
      'SELECT access_token_hash FROM auth.sessions LIMIT 1',
      'SELECT token_hash FROM auth.refresh_tokens LIMIT 1',
      'SELECT installation_commitment FROM auth.session_families LIMIT 1',
      `SELECT auth.revoke_locked_family('${issued.familyId}', 'LOGOUT', now())`,
    ];
    for (const statement of statements) {
      const client = await harness.runtime.connect();
      try {
        await expect(client.query(statement)).rejects.toMatchObject({ code: '42501' });
      } finally {
        client.release();
      }
    }
  });

  it('rejects a second ISSUED token and any change to a terminal family, even for the owner (R-07)', async () => {
    const accountId = await harness.createAccount();
    const issued = await harness.issue(accountId);
    await expect(
      harness.admin.query(
        `INSERT INTO auth.refresh_tokens (id, family_id, token_hash, state, issued_at)
         VALUES ($1, $2, decode(repeat('11', 32), 'hex'), 'ISSUED', now())`,
        [uuidV7.uuidV7(), issued.familyId],
      ),
    ).rejects.toMatchObject({ constraint: 'refresh_token_one_issued_per_family' });

    await harness.transactions.inTransaction((sql) =>
      harness.sessions.revokeAllForAccount(sql, {
        accountId,
        reason: 'SECURITY_POLICY',
        at: harness.clock.now(),
        correlationId: uuidV7.uuidV7(),
      }),
    );
    for (const statement of [
      "UPDATE auth.session_families SET state = 'ACTIVE', revoke_reason = NULL, revoked_at = NULL, version = version + 1 WHERE id = $1",
      'UPDATE auth.session_families SET authenticated_at = now(), version = version + 1 WHERE id = $1',
    ]) {
      await expect(harness.admin.query(statement, [issued.familyId])).rejects.toMatchObject({
        constraint: 'session_family_terminal',
      });
    }
    await expect(
      harness.admin.query(
        "UPDATE auth.refresh_tokens SET state = 'ISSUED', revoked_at = NULL WHERE family_id = $1",
        [issued.familyId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.admin.query('DELETE FROM auth.session_families WHERE id = $1', [issued.familyId]),
    ).rejects.toMatchObject({ constraint: 'session_records_retained' });
  });

  it('refuses to roll back migration 0017 while session rows exist (R-32)', async () => {
    await harness.issue(await harness.createAccount());
    const versions = (await harness.migrator.status()).map((entry) => entry.version);
    for (const version of versions.filter((entry) => entry > '0017').reverse()) {
      expect(await harness.migrator.down()).toEqual([version]);
    }
    await expect(harness.migrator.down()).rejects.toThrow('rolled back');
    expect((await harness.migrator.status()).at(-1)?.version).toBe('0017');
    await harness.migrator.up();
  });
});
