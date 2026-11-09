import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSessionHarness,
  installation,
  seconds,
  uuidV7,
  type SessionHarness,
} from './session-harness';

const CONCURRENT_REFRESHES = 100;
const ROUNDS = 10;
// PostgreSQL's default max_connections is 100 with superuser slots reserved, so 100 concurrent
// refreshes share 60 connections. Every refresh still races on the same family row lock.
const RUNTIME_CONNECTIONS = 60;

interface RoundResult {
  readonly round: number;
  readonly rotated: number;
  readonly reauthenticate: number;
  readonly familyState: string;
  readonly issuedTokens: number;
  readonly chainConsistent: boolean;
}

describe('concurrent refresh of one token (R-08)', () => {
  let harness: SessionHarness;

  beforeAll(async () => {
    harness = await createSessionHarness(RUNTIME_CONNECTIONS);
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  it(`ends each of ${ROUNDS} rounds with at most one ISSUED token and a consistent family`, async () => {
    const rounds: RoundResult[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const accountId = await harness.createAccount();
      const device = installation();
      const issued = await harness.issue(accountId, device);
      const at = seconds(harness.clock.now(), 5);
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_REFRESHES }, () =>
          harness.sessions.refresh({
            refreshToken: issued.refreshToken,
            installationCommitment: device,
            at,
            correlationId: uuidV7.uuidV7(),
          }),
        ),
      );

      const family = await harness.admin.query<{ state: string }>(
        'SELECT state FROM auth.session_families WHERE id = $1',
        [issued.familyId],
      );
      const tokens = await harness.admin.query<{
        id: string;
        predecessor_id: string | null;
        state: string;
      }>('SELECT id, predecessor_id, state FROM auth.refresh_tokens WHERE family_id = $1', [
        issued.familyId,
      ]);
      // Every token but the first has exactly one predecessor in the family, so the tokens form
      // a single chain from the original token.
      const ids = new Set(tokens.rows.map((row) => row.id));
      const roots = tokens.rows.filter((row) => row.predecessor_id === null);
      const chainConsistent =
        roots.length === 1 &&
        tokens.rows.every((row) => row.predecessor_id === null || ids.has(row.predecessor_id));

      rounds.push({
        round,
        rotated: results.filter((result) => result.kind === 'ROTATED').length,
        reauthenticate: results.filter((result) => result.kind === 'REAUTHENTICATION_REQUIRED')
          .length,
        familyState: family.rows[0]?.state ?? 'MISSING',
        issuedTokens: tokens.rows.filter((row) => row.state === 'ISSUED').length,
        chainConsistent,
      });
    }

    // Machine-readable result for the R-08 evidence (T-A4).
    for (const result of rounds) {
      expect(result.rotated + result.reauthenticate).toBe(CONCURRENT_REFRESHES);
      expect(result.chainConsistent).toBe(true);
      expect(result.issuedTokens).toBeLessThanOrEqual(1);
      if (result.familyState === 'ACTIVE') {
        expect(result.issuedTokens).toBe(1);
      } else {
        expect(result.familyState).toBe('REVOKED');
        expect(result.issuedTokens).toBe(0);
      }
    }
  }, 180_000);
});
