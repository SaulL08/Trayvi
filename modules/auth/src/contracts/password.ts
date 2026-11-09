import type { ClientContext } from './challenge';
import type { SqlExecutor } from './runtime';

// SPEC-002 design §2.1. Frozen before streams start.

export interface PasswordPolicy {
  readonly minLength: 12;
  readonly maxLength: 128;
}

export type PasswordSetResult =
  | { readonly kind: 'SET' }
  | { readonly kind: 'REJECTED'; readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'COMPROMISED' };

export type PasswordVerifyResult =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'MISMATCH' }
  | { readonly kind: 'NO_CREDENTIAL' }
  | { readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number };

export interface PasswordCredentials {
  hasActive(sql: SqlExecutor, accountId: string): Promise<boolean>;
  verify(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly candidate: unknown;
      readonly client: ClientContext;
      readonly at: Date;
    },
  ): Promise<PasswordVerifyResult>;
  set(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly password: unknown;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<PasswordSetResult>;
  remove(
    sql: SqlExecutor,
    command: {
      readonly accountId: string;
      readonly reason: 'RECOVERY';
      readonly caseId: string;
      readonly at: Date;
      readonly correlationId: string;
    },
  ): Promise<void>;
}

export interface CompromisedPasswordChecker {
  isCompromised(password: string): Promise<boolean>;
}
