import type { SqlExecutor } from './runtime';

// SPEC-002 design §2.1. Frozen before streams start.

export type AssuranceLevel = 'AAL1' | 'AAL2';
export type AuthFactor = 'CONTACT_OTP' | 'PASSWORD' | 'IDENTITY_REVERIFICATION';
export type FamilyRevokeReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'REUSE_DETECTED'
  | 'ACCOUNT_STATE'
  | 'RECOVERY'
  | 'CONTACT_CHANGED'
  | 'PASSWORD_CHANGED'
  | 'SECURITY_POLICY';

export interface SessionPolicy {
  readonly accessTokenSeconds: number; // 300..900
  readonly idleSeconds: number; // 86400..5184000
  readonly absoluteSeconds: number; // >= idleSeconds, <= 15552000
  readonly rotationGraceSeconds: number; // 0..60
  readonly recentAuthSeconds: number; // 60..900
}

export interface IssueSessionCommand {
  readonly accountId: string;
  readonly installationCommitment: Buffer;
  readonly factors: readonly AuthFactor[];
  readonly authenticatedAt: Date;
  readonly correlationId: string;
}

export interface IssuedSession {
  readonly familyId: string;
  readonly sessionId: string;
  readonly accessToken: string; // returned once
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string; // returned once
  readonly familyExpiresAt: Date; // min(idle, absolute)
  readonly newInstallation: boolean;
}

export type RefreshResult =
  | { readonly kind: 'ROTATED'; readonly session: IssuedSession }
  | { readonly kind: 'REAUTHENTICATION_REQUIRED' };

export interface SessionFamilySummary {
  readonly familyId: string;
  readonly createdAt: Date;
  readonly lastRotatedAt: Date;
  readonly assurance: AssuranceLevel;
  readonly current: boolean;
}

export interface SessionCommands {
  issue(sql: SqlExecutor, command: IssueSessionCommand): Promise<IssuedSession>;
  refresh(command: {
    readonly refreshToken: unknown;
    readonly installationCommitment: Buffer;
    readonly at: Date;
    readonly correlationId: string;
  }): Promise<RefreshResult>;
  revokeFamily(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly familyId: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<{ readonly kind: 'REVOKED' | 'NOT_FOUND' }>;
  recordStepUp(
    sql: SqlExecutor,
    command: { readonly familyId: string; readonly factor: AuthFactor; readonly at: Date },
  ): Promise<void>;
  listFamilies(
    accountId: string,
    currentFamilyId: string,
  ): Promise<readonly SessionFamilySummary[]>;
}

export interface AccountSessionRevoker {
  /** Runs in the caller's transaction. Returns the number of families revoked. */
  revokeAllForAccount(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly exceptFamilyId?: string;
      readonly reason: FamilyRevokeReason;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<number>;
}

export type AccessTokenResolution =
  | {
      readonly kind: 'ACTIVE';
      readonly accountId: string;
      readonly sessionId: string;
      readonly familyId: string;
      readonly authenticatedAt: Date;
      readonly assurance: AssuranceLevel;
      readonly factors: readonly AuthFactor[];
    }
  | { readonly kind: 'INVALID' };

export interface AccessTokenResolver {
  resolve(accessToken: unknown, at: Date): Promise<AccessTokenResolution>;
}
