export type RateLimitDimension =
  | 'CHALLENGE_START_CONTACT_HOUR'
  | 'CHALLENGE_START_CONTACT_DAY'
  | 'CHALLENGE_START_NETWORK_HOUR'
  | 'CHALLENGE_START_INSTALLATION_HOUR'
  | 'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY'
  | 'PASSWORD_FAILURE_ACCOUNT'
  | 'PASSWORD_FAILURE_NETWORK_HOUR'
  | 'RECOVERY_START_ACCOUNT_DAY'
  | 'RECOVERY_START_NETWORK_HOUR'
  | 'REGISTRATION_START_CONTACT_30D'
  | 'REGISTRATION_START_NETWORK_DAY'
  | 'REVERIFICATION_GLOBAL_HOUR'
  | 'DELIVERY_GLOBAL_MINUTE';

export interface RateLimitRule {
  readonly dimension: RateLimitDimension;
  readonly limit: number;
  readonly windowSeconds: number;
}

export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /** Consumes one unit atomically and decides. `subject` is already a commitment. */
  consume(dimension: RateLimitDimension, subject: Buffer, at: Date): Promise<RateLimitDecision>;
  /** Reads without consuming. */
  peek(dimension: RateLimitDimension, subject: Buffer, at: Date): Promise<RateLimitDecision>;
}

export type SubjectLabel = 'installation' | 'network-prefix' | 'contact' | 'account' | 'global';

export interface SubjectCommitter {
  /** HMAC-SHA-256 under auth-subject-commitment over "trayvi.auth-subject\0<label>\0<value>". */
  commit(label: SubjectLabel, value: string | Buffer): Buffer;
}
