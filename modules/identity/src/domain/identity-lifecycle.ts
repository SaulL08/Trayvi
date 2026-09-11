export type IdentityStatus = 'PENDING' | 'ESTABLISHED' | 'RESTRICTED' | 'RETIRED';
export type VerificationCaseStatus =
  'PENDING' | 'VERIFIED' | 'FAILED' | 'INCONCLUSIVE' | 'EXPIRED' | 'CANCELLED';
export type ReviewStatus =
  'NOT_REQUIRED' | 'QUEUED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type DocumentStatus = 'CURRENT' | 'SUPERSEDED' | 'REVOKED' | 'CRYPTOSHREDDED';
export type FingerprintClaimStatus = 'RESERVED' | 'BOUND' | 'TOMBSTONED' | 'ABANDONED';

export interface VersionedState<State extends string> {
  readonly id: string;
  readonly status: State;
  readonly version: number;
}

export interface IdentityEstablishmentProof {
  readonly verificationCaseStatus: VerificationCaseStatus;
  readonly reviewStatus: ReviewStatus;
  readonly documentClaimStatus: FingerprintClaimStatus;
}

export type IdentityActorClass =
  'TRUSTED_VERIFICATION_HANDLER' | 'SYSTEM_POLICY' | 'AUTHORIZED_REVIEWER';

export interface IdentityTransitionCommand {
  readonly to: IdentityStatus;
  readonly expectedVersion: number;
  readonly actorClass: IdentityActorClass;
  readonly actorReference: string;
  readonly reasonCode: string;
  readonly evidenceReference: string;
  readonly occurredAt: Date;
}

export interface IdentityTransitionResult extends VersionedState<IdentityStatus> {
  readonly transition: {
    readonly from: IdentityStatus;
    readonly to: IdentityStatus;
    readonly aggregateVersion: number;
    readonly actorClass: IdentityActorClass;
    readonly actorReference: string;
    readonly reasonCode: string;
    readonly evidenceReference: string;
    readonly occurredAt: Date;
  };
}

export class IdentityLifecycleError extends Error {
  readonly code:
    | 'STALE_IDENTITY_VERSION'
    | 'INVALID_IDENTITY_TRANSITION'
    | 'UNAUTHORIZED_IDENTITY_TRANSITION_ACTOR'
    | 'INVALID_IDENTITY_TRANSITION_EVIDENCE'
    | 'IDENTITY_ESTABLISHMENT_PRECONDITION_FAILED'
    | 'INVALID_VERIFICATION_CASE_TRANSITION'
    | 'INVALID_REVIEW_TRANSITION'
    | 'INVALID_DOCUMENT_TRANSITION'
    | 'INVALID_FINGERPRINT_CLAIM_TRANSITION';

  constructor(code: IdentityLifecycleError['code']) {
    super(code);
    this.name = 'IdentityLifecycleError';
    this.code = code;
  }
}

const identityTransitions: Readonly<Record<IdentityStatus, readonly IdentityStatus[]>> = {
  PENDING: ['ESTABLISHED', 'RETIRED'],
  ESTABLISHED: ['RESTRICTED', 'RETIRED'],
  RESTRICTED: ['ESTABLISHED', 'RETIRED'],
  RETIRED: [],
};

const identityActorsByTransition: Readonly<Record<string, readonly IdentityActorClass[]>> = {
  'PENDING:ESTABLISHED': ['TRUSTED_VERIFICATION_HANDLER'],
  'PENDING:RETIRED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'ESTABLISHED:RESTRICTED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'ESTABLISHED:RETIRED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'RESTRICTED:ESTABLISHED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'RESTRICTED:RETIRED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
};

const verificationTransitions: Readonly<
  Record<VerificationCaseStatus, readonly VerificationCaseStatus[]>
> = {
  PENDING: ['VERIFIED', 'FAILED', 'INCONCLUSIVE', 'EXPIRED', 'CANCELLED'],
  VERIFIED: [],
  FAILED: [],
  INCONCLUSIVE: [],
  EXPIRED: [],
  CANCELLED: [],
};

const reviewTransitions: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  NOT_REQUIRED: [],
  QUEUED: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

const documentTransitions: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  CURRENT: ['SUPERSEDED', 'REVOKED', 'CRYPTOSHREDDED'],
  SUPERSEDED: ['CRYPTOSHREDDED'],
  REVOKED: ['CRYPTOSHREDDED'],
  CRYPTOSHREDDED: [],
};

const claimTransitions: Readonly<
  Record<FingerprintClaimStatus, readonly FingerprintClaimStatus[]>
> = {
  RESERVED: ['BOUND', 'TOMBSTONED', 'ABANDONED'],
  BOUND: ['TOMBSTONED'],
  TOMBSTONED: [],
  ABANDONED: [],
};

export function transitionIdentity(
  identity: VersionedState<IdentityStatus>,
  command: IdentityTransitionCommand,
  proof?: IdentityEstablishmentProof,
): IdentityTransitionResult {
  if (identity.version !== command.expectedVersion) {
    throw new IdentityLifecycleError('STALE_IDENTITY_VERSION');
  }
  if (
    command.actorReference.trim().length === 0 ||
    command.reasonCode.trim().length === 0 ||
    command.evidenceReference.trim().length === 0 ||
    !Number.isFinite(command.occurredAt.getTime())
  ) {
    throw new IdentityLifecycleError('INVALID_IDENTITY_TRANSITION_EVIDENCE');
  }
  if (!identityTransitions[identity.status].includes(command.to)) {
    throw new IdentityLifecycleError('INVALID_IDENTITY_TRANSITION');
  }
  if (
    !(identityActorsByTransition[`${identity.status}:${command.to}`] ?? []).includes(
      command.actorClass,
    )
  ) {
    throw new IdentityLifecycleError('UNAUTHORIZED_IDENTITY_TRANSITION_ACTOR');
  }
  if (
    command.to === 'ESTABLISHED' &&
    (proof?.verificationCaseStatus !== 'VERIFIED' ||
      !['NOT_REQUIRED', 'APPROVED'].includes(proof.reviewStatus) ||
      proof.documentClaimStatus !== 'BOUND')
  ) {
    throw new IdentityLifecycleError('IDENTITY_ESTABLISHMENT_PRECONDITION_FAILED');
  }
  const aggregateVersion = identity.version + 1;
  return {
    ...identity,
    status: command.to,
    version: aggregateVersion,
    transition: {
      from: identity.status,
      to: command.to,
      aggregateVersion,
      actorClass: command.actorClass,
      actorReference: command.actorReference,
      reasonCode: command.reasonCode,
      evidenceReference: command.evidenceReference,
      occurredAt: command.occurredAt,
    },
  };
}

function transitionSimple<State extends string>(
  current: State,
  next: State,
  allowed: Readonly<Record<State, readonly State[]>>,
  code: IdentityLifecycleError['code'],
): State {
  if (!allowed[current].includes(next)) throw new IdentityLifecycleError(code);
  return next;
}

export const transitionVerificationCase = (
  current: VerificationCaseStatus,
  next: VerificationCaseStatus,
): VerificationCaseStatus =>
  transitionSimple(current, next, verificationTransitions, 'INVALID_VERIFICATION_CASE_TRANSITION');

export const transitionReview = (current: ReviewStatus, next: ReviewStatus): ReviewStatus =>
  transitionSimple(current, next, reviewTransitions, 'INVALID_REVIEW_TRANSITION');

export const transitionDocument = (current: DocumentStatus, next: DocumentStatus): DocumentStatus =>
  transitionSimple(current, next, documentTransitions, 'INVALID_DOCUMENT_TRANSITION');

export const transitionFingerprintClaim = (
  current: FingerprintClaimStatus,
  next: FingerprintClaimStatus,
): FingerprintClaimStatus =>
  transitionSimple(current, next, claimTransitions, 'INVALID_FINGERPRINT_CLAIM_TRANSITION');
