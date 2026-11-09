import { ConfigValidationError } from './config-error';
import type { ConfigIssue } from './config-error';
import type { RawEnvironment, RuntimeEnvironment } from './types';

/**
 * Auth settings for SPEC-001 (PLAN §§6, 8.2, 11, 14) and SPEC-002 (PLAN §§9.2, 10). They are parsed separately from AppConfig so
 * processes that do not compose Auth keep their existing configuration surface.
 */
export interface AuthCallingCodeConfig {
  readonly code: string;
  readonly nationalNumberLength: number;
  readonly destinationCodes?: readonly string[];
}

export type AuthRateLimitDimension =
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

export interface AuthRateLimitRuleConfig {
  readonly dimension: AuthRateLimitDimension;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AuthCallbackProviderConfig {
  readonly alias: string;
  /** HMAC-SHA-256 signing secret; never logged. */
  readonly secret: Buffer;
}

/** PLAN §9.2 lifetimes. Mirrors `SessionPolicy` in `@trayvi/auth` contracts. */
export interface AuthSessionConfig {
  readonly accessTokenSeconds: number; // 300..900
  readonly idleSeconds: number; // 86400..5184000
  readonly absoluteSeconds: number; // >= idleSeconds, <= 15552000
  readonly rotationGraceSeconds: number; // 0..60
  readonly recentAuthSeconds: number; // 60..900
}

/** PLAN §10 password settings. */
export interface AuthPasswordConfig {
  /** Cap on concurrent scrypt verifications, so hashing never starves the event loop. */
  readonly verificationConcurrency: number;
  /** Newline-separated compromised-password list. Absent: the synthetic Phase 2 list. */
  readonly compromisedListPath?: string;
}

export interface AuthConfig {
  readonly numbering: {
    readonly defaultCallingCode?: string;
    readonly callingCodes: readonly AuthCallingCodeConfig[];
  };
  readonly challenge: {
    readonly codeLifetimeSeconds: number;
    readonly maxFailedAttempts: number;
    readonly maxResends: number;
    readonly resendCooldownSeconds: number;
    readonly proofLifetimeSeconds: number;
  };
  readonly rateLimits: readonly AuthRateLimitRuleConfig[];
  readonly delivery: {
    readonly timeoutMs: number;
    readonly budgetPerMinute: number;
  };
  readonly callbacks: {
    readonly maxBodyBytes: number;
    readonly timestampToleranceSeconds: number;
    readonly providers: readonly AuthCallbackProviderConfig[];
  };
  readonly session: AuthSessionConfig;
  readonly passwordPolicy: AuthPasswordConfig;
  /** Where Auth key material comes from. Only the synthetic test source exists in Phase 2. */
  readonly keys: { readonly source: 'synthetic' };
}

const HOUR = 3_600;
const DAY = 86_400;

/**
 * PLAN §11 defaults. Entries marked provisional are not fixed by the plan and need Trust & Safety
 * values (PLAN §19.2) before production.
 */
const RATE_LIMIT_DEFAULTS: readonly AuthRateLimitRuleConfig[] = [
  { dimension: 'CHALLENGE_START_CONTACT_HOUR', limit: 5, windowSeconds: HOUR },
  { dimension: 'CHALLENGE_START_CONTACT_DAY', limit: 10, windowSeconds: DAY },
  { dimension: 'CHALLENGE_START_NETWORK_HOUR', limit: 30, windowSeconds: HOUR },
  { dimension: 'CHALLENGE_START_INSTALLATION_HOUR', limit: 10, windowSeconds: HOUR },
  { dimension: 'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY', limit: 10, windowSeconds: DAY },
  { dimension: 'PASSWORD_FAILURE_ACCOUNT', limit: 5, windowSeconds: 900 },
  // Provisional: PLAN §11 names no network password limit.
  { dimension: 'PASSWORD_FAILURE_NETWORK_HOUR', limit: 50, windowSeconds: HOUR },
  { dimension: 'RECOVERY_START_ACCOUNT_DAY', limit: 3, windowSeconds: DAY },
  { dimension: 'RECOVERY_START_NETWORK_HOUR', limit: 30, windowSeconds: HOUR },
  { dimension: 'REGISTRATION_START_CONTACT_30D', limit: 3, windowSeconds: 30 * DAY },
  { dimension: 'REGISTRATION_START_NETWORK_DAY', limit: 10, windowSeconds: DAY },
  // Provisional: PLAN §11 names no global re-verification budget.
  { dimension: 'REVERIFICATION_GLOBAL_HOUR', limit: 100, windowSeconds: HOUR },
  // Provisional: PLAN §11 leaves the delivery budget to configuration.
  { dimension: 'DELIVERY_GLOBAL_MINUTE', limit: 60, windowSeconds: 60 },
];

const CALLBACK_ALIAS = /^[a-z][a-z0-9-]{0,31}$/u;
const HEX_SECRET = /^(?:[0-9a-f]{2}){32,64}$/u;

class IssueCollector {
  readonly issues: ConfigIssue[] = [];

  add(field: string, constraint: string): void {
    this.issues.push({ field, constraint });
  }

  integer(
    environment: RawEnvironment,
    field: string,
    defaultValue: number,
    minimum: number,
    maximum: number,
  ): number {
    const raw = environment[field];
    if (raw === undefined || raw === '') return defaultValue;
    if (!/^\d{1,9}$/u.test(raw.trim())) {
      this.add(field, `must be an integer between ${minimum} and ${maximum}`);
      return defaultValue;
    }
    const value = Number(raw.trim());
    if (value < minimum || value > maximum) {
      this.add(field, `must be an integer between ${minimum} and ${maximum}`);
      return defaultValue;
    }
    return value;
  }
}

function parseCallingCodes(raw: string, issues: IssueCollector): AuthCallingCodeConfig[] {
  const entries = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const parsed: AuthCallingCodeConfig[] = [];
  for (const entry of entries) {
    const match = /^(\d{1,3}):(\d{1,2})(?::(\d{1,4}(?:,\d{1,4})*))?$/u.exec(entry);
    const length = match ? Number(match[2]) : 0;
    if (!match?.[1] || length < 4 || length > 14 || match[1].length + length > 15) {
      issues.add(
        'AUTH_PHONE_CALLING_CODES',
        'must list "code:nationalLength[:destination,...]" entries separated by ";"',
      );
      continue;
    }
    parsed.push({
      code: match[1],
      nationalNumberLength: length,
      ...(match[3] ? { destinationCodes: match[3].split(',') } : {}),
    });
  }
  if (parsed.length === 0 && issues.issues.length === 0) {
    issues.add('AUTH_PHONE_CALLING_CODES', 'must configure at least one calling code');
  }
  if (new Set(parsed.map((entry) => entry.code)).size !== parsed.length) {
    issues.add('AUTH_PHONE_CALLING_CODES', 'must not repeat a calling code');
  }
  return parsed;
}

function parseProviders(
  environment: RawEnvironment,
  runtime: RuntimeEnvironment,
  issues: IssueCollector,
): AuthCallbackProviderConfig[] {
  const aliases = (environment.AUTH_CALLBACK_PROVIDERS ?? '')
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
  const providers: AuthCallbackProviderConfig[] = [];
  for (const alias of new Set(aliases)) {
    if (!CALLBACK_ALIAS.test(alias)) {
      issues.add('AUTH_CALLBACK_PROVIDERS', 'must list lowercase provider aliases');
      continue;
    }
    if ((runtime === 'production' || runtime === 'staging') && alias === 'synthetic') {
      issues.add('AUTH_CALLBACK_PROVIDERS', 'must not enable the synthetic provider');
      continue;
    }
    const field = `AUTH_CALLBACK_SECRET_${alias.toUpperCase().replaceAll('-', '_')}`;
    const secret = environment[field]?.trim().toLowerCase() ?? '';
    if (!HEX_SECRET.test(secret)) {
      // The constraint never echoes the configured value.
      issues.add(field, 'must be 32 to 64 random bytes in hexadecimal');
      continue;
    }
    providers.push({ alias, secret: Buffer.from(secret, 'hex') });
  }
  if (aliases.length !== new Set(aliases).size) {
    issues.add('AUTH_CALLBACK_PROVIDERS', 'must not repeat a provider alias');
  }
  return providers;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function parseAuthConfig(
  environment: RawEnvironment,
  runtime: RuntimeEnvironment,
): AuthConfig {
  const issues = new IssueCollector();

  const callingCodes = parseCallingCodes(
    environment.AUTH_PHONE_CALLING_CODES ?? '1:10:809,829,849',
    issues,
  );
  const rawDefault = (environment.AUTH_PHONE_DEFAULT_CALLING_CODE ?? '1').trim();
  let defaultCallingCode: string | undefined;
  if (rawDefault !== '' && rawDefault !== 'none') {
    if (!callingCodes.some((entry) => entry.code === rawDefault)) {
      issues.add('AUTH_PHONE_DEFAULT_CALLING_CODE', 'must be one of the configured calling codes');
    } else {
      defaultCallingCode = rawDefault;
    }
  }

  const challenge = {
    codeLifetimeSeconds: issues.integer(
      environment,
      'AUTH_OTP_CODE_LIFETIME_SECONDS',
      300,
      120,
      600,
    ),
    maxFailedAttempts: issues.integer(environment, 'AUTH_OTP_MAX_FAILED_ATTEMPTS', 5, 3, 10),
    maxResends: issues.integer(environment, 'AUTH_OTP_MAX_RESENDS', 3, 0, 5),
    resendCooldownSeconds: issues.integer(
      environment,
      'AUTH_OTP_RESEND_COOLDOWN_SECONDS',
      30,
      15,
      120,
    ),
    proofLifetimeSeconds: issues.integer(
      environment,
      'AUTH_CONTACT_PROOF_LIFETIME_SECONDS',
      600,
      120,
      900,
    ),
  };

  const rateLimits = RATE_LIMIT_DEFAULTS.map((rule) => ({
    ...rule,
    limit: issues.integer(environment, `AUTH_RATE_LIMIT_${rule.dimension}`, rule.limit, 1, 100_000),
  }));
  const budget = rateLimits.find((rule) => rule.dimension === 'DELIVERY_GLOBAL_MINUTE');

  const session: AuthSessionConfig = {
    accessTokenSeconds: issues.integer(environment, 'AUTH_ACCESS_TOKEN_SECONDS', 600, 300, 900),
    idleSeconds: issues.integer(environment, 'AUTH_SESSION_IDLE_SECONDS', 30 * DAY, DAY, 60 * DAY),
    absoluteSeconds: issues.integer(
      environment,
      'AUTH_SESSION_ABSOLUTE_SECONDS',
      90 * DAY,
      DAY,
      180 * DAY,
    ),
    rotationGraceSeconds: issues.integer(environment, 'AUTH_REFRESH_GRACE_SECONDS', 30, 0, 60),
    recentAuthSeconds: issues.integer(environment, 'AUTH_RECENT_AUTH_SECONDS', 300, 60, 900),
  };
  if (session.absoluteSeconds < session.idleSeconds) {
    issues.add(
      'AUTH_SESSION_ABSOLUTE_SECONDS',
      'must not be shorter than AUTH_SESSION_IDLE_SECONDS',
    );
  }

  const compromisedListPath = environment.AUTH_COMPROMISED_PASSWORD_LIST_PATH?.trim();
  const passwordPolicy: AuthPasswordConfig = {
    verificationConcurrency: issues.integer(
      environment,
      'AUTH_PASSWORD_VERIFICATION_CONCURRENCY',
      8,
      1,
      64,
    ),
    ...(compromisedListPath ? { compromisedListPath } : {}),
  };

  const keySource = (environment.AUTH_KEY_SOURCE ?? 'synthetic').trim();
  if (keySource !== 'synthetic') {
    issues.add('AUTH_KEY_SOURCE', 'must name a supported key source');
  } else if (runtime === 'production' || runtime === 'staging') {
    issues.add('AUTH_KEY_SOURCE', 'synthetic keys are forbidden outside development and test');
  }

  const config: AuthConfig = {
    numbering: {
      ...(defaultCallingCode ? { defaultCallingCode } : {}),
      callingCodes,
    },
    challenge,
    rateLimits,
    delivery: {
      timeoutMs: issues.integer(environment, 'AUTH_DELIVERY_TIMEOUT_MS', 3_000, 250, 10_000),
      budgetPerMinute: budget?.limit ?? 60,
    },
    callbacks: {
      maxBodyBytes: 16_384,
      timestampToleranceSeconds: 300,
      providers: parseProviders(environment, runtime, issues),
    },
    session,
    passwordPolicy,
    keys: { source: 'synthetic' },
  };

  if (issues.issues.length > 0) throw new ConfigValidationError(issues.issues);
  return freeze(config);
}
