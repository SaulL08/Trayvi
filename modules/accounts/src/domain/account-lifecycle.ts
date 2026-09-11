export type AccountStatus = 'PENDING_IDENTITY' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';

export type AccountActorClass =
  | 'ENROLLMENT_SERVICE'
  | 'TRUSTED_VERIFICATION_HANDLER'
  | 'SYSTEM_POLICY'
  | 'AUTHORIZED_REVIEWER'
  | 'PERSON_REQUEST';

export interface AccountSnapshot {
  readonly id: string;
  readonly status: AccountStatus;
  readonly version: number;
}

export interface AccountTransitionCommand {
  readonly to: AccountStatus;
  readonly expectedVersion: number;
  readonly actorClass: AccountActorClass;
  readonly actorReference: string;
  readonly reasonCode: string;
  readonly evidenceReference: string;
  readonly occurredAt: Date;
}

export interface AccountTransitionResult extends AccountSnapshot {
  readonly transition: {
    readonly from: AccountStatus;
    readonly to: AccountStatus;
    readonly aggregateVersion: number;
    readonly actorClass: AccountActorClass;
    readonly actorReference: string;
    readonly reasonCode: string;
    readonly evidenceReference: string;
    readonly occurredAt: Date;
  };
}

export interface AccountActivationProof {
  readonly identityEstablished: boolean;
  readonly documentClaimBound: boolean;
}

const transitions: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  PENDING_IDENTITY: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['RESTRICTED', 'SUSPENDED', 'CLOSED'],
  RESTRICTED: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'RESTRICTED', 'CLOSED'],
  CLOSED: [],
};

const actorsByTransition: Readonly<Record<string, readonly AccountActorClass[]>> = {
  'PENDING_IDENTITY:ACTIVE': ['TRUSTED_VERIFICATION_HANDLER'],
  'PENDING_IDENTITY:CLOSED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER', 'PERSON_REQUEST'],
  'ACTIVE:RESTRICTED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'ACTIVE:SUSPENDED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'ACTIVE:CLOSED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER', 'PERSON_REQUEST'],
  'RESTRICTED:ACTIVE': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'RESTRICTED:SUSPENDED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'RESTRICTED:CLOSED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER', 'PERSON_REQUEST'],
  'SUSPENDED:ACTIVE': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'SUSPENDED:RESTRICTED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER'],
  'SUSPENDED:CLOSED': ['SYSTEM_POLICY', 'AUTHORIZED_REVIEWER', 'PERSON_REQUEST'],
};

export class AccountTransitionError extends Error {
  readonly code:
    | 'STALE_ACCOUNT_VERSION'
    | 'INVALID_ACCOUNT_TRANSITION'
    | 'UNAUTHORIZED_ACCOUNT_TRANSITION_ACTOR'
    | 'ACCOUNT_ACTIVATION_PRECONDITION_FAILED'
    | 'INVALID_ACCOUNT_TRANSITION_EVIDENCE';

  constructor(code: AccountTransitionError['code']) {
    super(code);
    this.name = 'AccountTransitionError';
    this.code = code;
  }
}

function hasSafeEvidence(command: AccountTransitionCommand): boolean {
  return (
    command.actorReference.trim().length > 0 &&
    command.reasonCode.trim().length > 0 &&
    command.evidenceReference.trim().length > 0 &&
    Number.isFinite(command.occurredAt.getTime())
  );
}

export function transitionAccount(
  account: AccountSnapshot,
  command: AccountTransitionCommand,
  activationProof?: AccountActivationProof,
): AccountTransitionResult {
  if (command.expectedVersion !== account.version) {
    throw new AccountTransitionError('STALE_ACCOUNT_VERSION');
  }
  if (!hasSafeEvidence(command)) {
    throw new AccountTransitionError('INVALID_ACCOUNT_TRANSITION_EVIDENCE');
  }
  if (!transitions[account.status].includes(command.to)) {
    throw new AccountTransitionError('INVALID_ACCOUNT_TRANSITION');
  }
  const allowedActors = actorsByTransition[`${account.status}:${command.to}`] ?? [];
  if (!allowedActors.includes(command.actorClass)) {
    throw new AccountTransitionError('UNAUTHORIZED_ACCOUNT_TRANSITION_ACTOR');
  }
  if (
    command.to === 'ACTIVE' &&
    (activationProof?.identityEstablished !== true || activationProof.documentClaimBound !== true)
  ) {
    throw new AccountTransitionError('ACCOUNT_ACTIVATION_PRECONDITION_FAILED');
  }

  const aggregateVersion = account.version + 1;
  return {
    id: account.id,
    status: command.to,
    version: aggregateVersion,
    transition: {
      from: account.status,
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
