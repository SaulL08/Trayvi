import type { SqlExecutor } from './runtime';
import type { AssuranceLevel, AuthFactor } from './session';

// SPEC-002 design §2.1. Frozen before streams start.

export type AccountStatusView =
  'PENDING_IDENTITY' | 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';

export interface AccountStateReader {
  read(
    sql: SqlExecutor,
    accountId: string,
  ): Promise<{ readonly status: AccountStatusView; readonly version: number } | undefined>;
}

export type RestrictionKind =
  'CONTACT_CHANGE_BLOCKED' | 'PASSWORD_CHANGE_BLOCKED' | 'HIGH_RISK_ACTIONS';

export interface ActiveRestriction {
  readonly kind: RestrictionKind;
  readonly endsAt: Date;
}

export interface RestrictionReader {
  active(sql: SqlExecutor, accountId: string, at: Date): Promise<readonly ActiveRestriction[]>;
}

export interface Principal {
  readonly accountId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly authenticatedAt: Date;
  readonly assurance: AssuranceLevel;
  readonly factors: readonly AuthFactor[];
  readonly accountStatus: Exclude<AccountStatusView, 'SUSPENDED' | 'CLOSED'>;
  readonly accountVersion: number;
  readonly restrictions: readonly ActiveRestriction[];
}

export interface StepUpRequirement {
  readonly maxAgeSeconds: number;
  readonly minAssurance: AssuranceLevel;
}

export type PrincipalResolution =
  | { readonly kind: 'AUTHENTICATED'; readonly principal: Principal }
  | { readonly kind: 'UNAUTHENTICATED' };

export interface PrincipalResolver {
  resolve(accessToken: unknown, at: Date): Promise<PrincipalResolution>;
}

/** Pure; returns undefined when satisfied. */
export type StepUpCheck = (
  principal: Principal,
  requirement: StepUpRequirement,
  at: Date,
) => StepUpRequirement | undefined;
