import { describe, expect, it } from 'vitest';

import {
  transitionDocument,
  transitionFingerprintClaim,
  transitionIdentity,
  transitionReview,
  transitionVerificationCase,
  type DocumentStatus,
  type FingerprintClaimStatus,
  type IdentityStatus,
  type ReviewStatus,
  type VerificationCaseStatus,
} from '../src/domain/identity-lifecycle';

const identityCommand = {
  to: 'ESTABLISHED' as const,
  expectedVersion: 0,
  actorClass: 'TRUSTED_VERIFICATION_HANDLER' as const,
  actorReference: 'trusted-verification-adapter',
  reasonCode: 'IDENTITY_ESTABLISHED',
  evidenceReference: '018f0000-0000-7000-8000-000000000001',
  occurredAt: new Date('2026-09-10T00:00:00.000Z'),
};

const establishmentProof = {
  verificationCaseStatus: 'VERIFIED' as const,
  reviewStatus: 'APPROVED' as const,
  documentClaimStatus: 'BOUND' as const,
};

describe('identity lifecycles', () => {
  it('enforces every identity state pair and stale version', () => {
    const statuses: readonly IdentityStatus[] = ['PENDING', 'ESTABLISHED', 'RESTRICTED', 'RETIRED'];
    const allowed = new Set([
      'PENDING:ESTABLISHED',
      'PENDING:RETIRED',
      'ESTABLISHED:RESTRICTED',
      'ESTABLISHED:RETIRED',
      'RESTRICTED:ESTABLISHED',
      'RESTRICTED:RETIRED',
    ]);
    for (const from of statuses) {
      for (const to of statuses) {
        const edge = `${from}:${to}`;
        const actorClass =
          edge === 'PENDING:ESTABLISHED'
            ? ('TRUSTED_VERIFICATION_HANDLER' as const)
            : ('SYSTEM_POLICY' as const);
        const attempt = (): unknown =>
          transitionIdentity(
            { id: 'identity', status: from, version: 4 },
            { ...identityCommand, to, expectedVersion: 4, actorClass },
            establishmentProof,
          );
        if (allowed.has(edge)) expect(attempt, edge).not.toThrow();
        else {
          expect(attempt, edge).toThrowError(
            expect.objectContaining({ code: 'INVALID_IDENTITY_TRANSITION' }),
          );
        }
      }
    }
    expect(() =>
      transitionIdentity(
        { id: 'identity', status: 'PENDING', version: 4 },
        { ...identityCommand, to: 'RETIRED', expectedVersion: 3, actorClass: 'SYSTEM_POLICY' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_IDENTITY_VERSION' }));
  });

  it('enforces complete case, review, document, and claim matrices', () => {
    const verification: readonly VerificationCaseStatus[] = [
      'PENDING',
      'VERIFIED',
      'FAILED',
      'INCONCLUSIVE',
      'EXPIRED',
      'CANCELLED',
    ];
    const reviews: readonly ReviewStatus[] = [
      'NOT_REQUIRED',
      'QUEUED',
      'IN_REVIEW',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ];
    const documents: readonly DocumentStatus[] = [
      'CURRENT',
      'SUPERSEDED',
      'REVOKED',
      'CRYPTOSHREDDED',
    ];
    const claims: readonly FingerprintClaimStatus[] = [
      'RESERVED',
      'BOUND',
      'TOMBSTONED',
      'ABANDONED',
    ];
    const verifyAllowed = new Set(
      ['VERIFIED', 'FAILED', 'INCONCLUSIVE', 'EXPIRED', 'CANCELLED'].map((to) => `PENDING:${to}`),
    );
    const reviewAllowed = new Set([
      'QUEUED:IN_REVIEW',
      'QUEUED:CANCELLED',
      'IN_REVIEW:APPROVED',
      'IN_REVIEW:REJECTED',
      'IN_REVIEW:CANCELLED',
    ]);
    const documentAllowed = new Set([
      'CURRENT:SUPERSEDED',
      'CURRENT:REVOKED',
      'CURRENT:CRYPTOSHREDDED',
      'SUPERSEDED:CRYPTOSHREDDED',
      'REVOKED:CRYPTOSHREDDED',
    ]);
    const claimAllowed = new Set([
      'RESERVED:BOUND',
      'RESERVED:TOMBSTONED',
      'RESERVED:ABANDONED',
      'BOUND:TOMBSTONED',
    ]);
    const exercise = <State extends string>(
      states: readonly State[],
      allowed: ReadonlySet<string>,
      transition: (from: State, to: State) => State,
    ): void => {
      for (const from of states) {
        for (const to of states) {
          const edge = `${from}:${to}`;
          if (allowed.has(edge)) expect(() => transition(from, to), edge).not.toThrow();
          else expect(() => transition(from, to), edge).toThrow();
        }
      }
    };
    exercise(verification, verifyAllowed, transitionVerificationCase);
    exercise(reviews, reviewAllowed, transitionReview);
    exercise(documents, documentAllowed, transitionDocument);
    exercise(claims, claimAllowed, transitionFingerprintClaim);
  });

  it('establishes only after trusted verification, accepted review, and binding', () => {
    expect(
      transitionIdentity({ id: 'identity', status: 'PENDING', version: 0 }, identityCommand, {
        verificationCaseStatus: 'VERIFIED',
        reviewStatus: 'NOT_REQUIRED',
        documentClaimStatus: 'BOUND',
      }),
    ).toMatchObject({
      id: 'identity',
      status: 'ESTABLISHED',
      version: 1,
      transition: {
        from: 'PENDING',
        to: 'ESTABLISHED',
        aggregateVersion: 1,
        actorClass: 'TRUSTED_VERIFICATION_HANDLER',
      },
    });

    for (const proof of [
      { ...establishmentProof, verificationCaseStatus: 'PENDING' as const },
      { ...establishmentProof, reviewStatus: 'QUEUED' as const },
      { ...establishmentProof, documentClaimStatus: 'RESERVED' as const },
    ]) {
      expect(() =>
        transitionIdentity(
          { id: 'identity', status: 'PENDING', version: 0 },
          identityCommand,
          proof,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'IDENTITY_ESTABLISHMENT_PRECONDITION_FAILED' }),
      );
    }
  });

  it('requires an authorized actor and complete transition evidence', () => {
    expect(() =>
      transitionIdentity(
        { id: 'identity', status: 'PENDING', version: 0 },
        { ...identityCommand, actorClass: 'AUTHORIZED_REVIEWER' },
        establishmentProof,
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED_IDENTITY_TRANSITION_ACTOR' }));
    for (const invalid of [
      { actorReference: ' ' },
      { reasonCode: ' ' },
      { evidenceReference: ' ' },
      { occurredAt: new Date(Number.NaN) },
    ]) {
      expect(() =>
        transitionIdentity(
          { id: 'identity', status: 'PENDING', version: 0 },
          { ...identityCommand, ...invalid },
          establishmentProof,
        ),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_IDENTITY_TRANSITION_EVIDENCE' }));
    }
  });

  it('keeps all terminal states terminal', () => {
    expect(() =>
      transitionIdentity(
        { id: 'i', status: 'RETIRED', version: 3 },
        {
          ...identityCommand,
          to: 'PENDING',
          expectedVersion: 3,
          actorClass: 'SYSTEM_POLICY',
        },
      ),
    ).toThrowError();
    expect(() => transitionVerificationCase('VERIFIED', 'PENDING')).toThrow();
    expect(() => transitionReview('REJECTED', 'IN_REVIEW')).toThrow();
    expect(() => transitionDocument('CRYPTOSHREDDED', 'CURRENT')).toThrow();
    expect(() => transitionFingerprintClaim('TOMBSTONED', 'BOUND')).toThrow();
  });
});
