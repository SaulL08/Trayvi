import { describe, expect, it } from 'vitest';

import {
  AccountTransitionError,
  transitionAccount,
  type AccountActorClass,
  type AccountStatus,
} from '../src';

const pending = {
  id: '018f0000-0000-7000-8000-000000000001',
  status: 'PENDING_IDENTITY' as const,
  version: 0,
};

const command = {
  to: 'ACTIVE' as const,
  expectedVersion: 0,
  actorClass: 'TRUSTED_VERIFICATION_HANDLER' as const,
  actorReference: 'verification-adapter',
  reasonCode: 'IDENTITY_ESTABLISHED',
  evidenceReference: '018f0000-0000-7000-8000-000000000002',
  occurredAt: new Date('2026-09-10T00:00:00.000Z'),
};

describe('account lifecycle', () => {
  it('enforces the complete approved state-transition matrix', () => {
    const statuses: readonly AccountStatus[] = [
      'PENDING_IDENTITY',
      'ACTIVE',
      'RESTRICTED',
      'SUSPENDED',
      'CLOSED',
    ];
    const allowed = new Set([
      'PENDING_IDENTITY:ACTIVE',
      'PENDING_IDENTITY:CLOSED',
      'ACTIVE:RESTRICTED',
      'ACTIVE:SUSPENDED',
      'ACTIVE:CLOSED',
      'RESTRICTED:ACTIVE',
      'RESTRICTED:SUSPENDED',
      'RESTRICTED:CLOSED',
      'SUSPENDED:ACTIVE',
      'SUSPENDED:RESTRICTED',
      'SUSPENDED:CLOSED',
    ]);

    for (const from of statuses) {
      for (const to of statuses) {
        const edge = `${from}:${to}`;
        const actorClass: AccountActorClass =
          edge === 'PENDING_IDENTITY:ACTIVE' ? 'TRUSTED_VERIFICATION_HANDLER' : 'SYSTEM_POLICY';
        const attempt = (): unknown =>
          transitionAccount(
            { ...pending, status: from, version: 7 },
            { ...command, to, expectedVersion: 7, actorClass },
            { identityEstablished: true, documentClaimBound: true },
          );
        if (allowed.has(edge)) {
          expect(attempt, edge).not.toThrow();
        } else {
          expect(attempt, edge).toThrowError(
            expect.objectContaining({ code: 'INVALID_ACCOUNT_TRANSITION' }),
          );
        }
      }
    }
  });

  it('activates only with established identity and a bound claim', () => {
    const result = transitionAccount(pending, command, {
      identityEstablished: true,
      documentClaimBound: true,
    });

    expect(result).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(result.transition).toMatchObject({
      from: 'PENDING_IDENTITY',
      to: 'ACTIVE',
      aggregateVersion: 1,
    });
  });

  it('rejects activation without either proof', () => {
    expect(() =>
      transitionAccount(pending, command, {
        identityEstablished: true,
        documentClaimBound: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_ACTIVATION_PRECONDITION_FAILED' }));
  });

  it('rejects stale, unauthorized, and terminal transitions', () => {
    expect(() => transitionAccount(pending, { ...command, expectedVersion: 1 })).toThrowError(
      expect.objectContaining({ code: 'STALE_ACCOUNT_VERSION' }),
    );
    expect(() =>
      transitionAccount(pending, { ...command, actorClass: 'PERSON_REQUEST' }),
    ).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED_ACCOUNT_TRANSITION_ACTOR' }));
    expect(() =>
      transitionAccount(
        { ...pending, status: 'CLOSED' },
        { ...command, to: 'ACTIVE' },
        { identityEstablished: true, documentClaimBound: true },
      ),
    ).toThrowError(AccountTransitionError);
  });

  it('requires actor, reason, evidence, and a valid timestamp', () => {
    for (const invalid of [
      { actorReference: ' ' },
      { reasonCode: ' ' },
      { evidenceReference: ' ' },
      { occurredAt: new Date(Number.NaN) },
    ]) {
      expect(() => transitionAccount(pending, { ...command, ...invalid })).toThrowError(
        expect.objectContaining({ code: 'INVALID_ACCOUNT_TRANSITION_EVIDENCE' }),
      );
    }
  });
});
