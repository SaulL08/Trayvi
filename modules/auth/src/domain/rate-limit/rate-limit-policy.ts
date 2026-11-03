import type {
  RateLimitDecision,
  RateLimitDimension,
  RateLimitRule,
} from '../../contracts/rate-limit';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** The window each dimension's name promises; configuration may tune limits, never windows. */
export const RATE_LIMIT_WINDOWS: Readonly<Record<RateLimitDimension, number>> = {
  CHALLENGE_START_CONTACT_HOUR: HOUR,
  CHALLENGE_START_CONTACT_DAY: DAY,
  CHALLENGE_START_NETWORK_HOUR: HOUR,
  CHALLENGE_START_INSTALLATION_HOUR: HOUR,
  CHALLENGE_VERIFY_FAILURE_CONTACT_DAY: DAY,
  PASSWORD_FAILURE_ACCOUNT: 15 * MINUTE,
  PASSWORD_FAILURE_NETWORK_HOUR: HOUR,
  RECOVERY_START_ACCOUNT_DAY: DAY,
  RECOVERY_START_NETWORK_HOUR: HOUR,
  REGISTRATION_START_CONTACT_30D: 30 * DAY,
  REGISTRATION_START_NETWORK_DAY: DAY,
  REVERIFICATION_GLOBAL_HOUR: HOUR,
  DELIVERY_GLOBAL_MINUTE: MINUTE,
};

export const RATE_LIMIT_DIMENSIONS = Object.keys(
  RATE_LIMIT_WINDOWS,
) as readonly RateLimitDimension[];
export const MAX_RATE_LIMIT = 100_000;

export class RateLimitPolicyError extends Error {
  constructor() {
    super('RATE_LIMIT_POLICY_INVALID');
    this.name = 'RateLimitPolicyError';
  }
}

/** Validated rules: every dimension exactly once, its canonical window, and a bounded limit. */
export class RateLimitPolicy {
  readonly #rules: ReadonlyMap<RateLimitDimension, RateLimitRule>;

  constructor(rules: readonly RateLimitRule[]) {
    const byDimension = new Map<RateLimitDimension, RateLimitRule>();
    for (const rule of rules) {
      const window = (RATE_LIMIT_WINDOWS as Readonly<Record<string, number>>)[rule.dimension];
      if (
        window === undefined ||
        byDimension.has(rule.dimension) ||
        rule.windowSeconds !== window ||
        !Number.isSafeInteger(rule.limit) ||
        rule.limit < 1 ||
        rule.limit > MAX_RATE_LIMIT
      ) {
        throw new RateLimitPolicyError();
      }
      byDimension.set(rule.dimension, Object.freeze({ ...rule }));
    }
    if (byDimension.size !== RATE_LIMIT_DIMENSIONS.length) throw new RateLimitPolicyError();
    this.#rules = byDimension;
  }

  rule(dimension: RateLimitDimension): RateLimitRule {
    const rule = this.#rules.get(dimension);
    if (!rule) throw new RateLimitPolicyError();
    return rule;
  }
}

export interface RateLimitWindow {
  readonly start: Date;
  readonly previousStart: Date;
  readonly end: Date;
}

/** Fixed windows aligned to the Unix epoch. */
export function windowFor(rule: RateLimitRule, at: Date): RateLimitWindow {
  const size = rule.windowSeconds * 1_000;
  const start = Math.floor(at.getTime() / size) * size;
  return {
    start: new Date(start),
    previousStart: new Date(start - size),
    end: new Date(start + size),
  };
}

/**
 * Decisions count the current and the previous fixed window together. Any interval of one window
 * length spans at most those two windows, so no interval ever admits more than `limit` units;
 * plain fixed windows would admit up to 2 x limit across a boundary (breaking the PLAN §11 bound).
 * Only admitted units are counted, so repeated denied attempts never extend a block.
 */
export function admitted(rule: RateLimitRule, used: number): RateLimitDecision {
  return { allowed: true, remaining: Math.max(0, rule.limit - used) };
}

export function denied(
  rule: RateLimitRule,
  window: RateLimitWindow,
  current: number,
  at: Date,
): RateLimitDecision {
  // At the window end the previous window stops counting and the current one becomes "previous";
  // if it alone already holds the limit, the next unit waits one more window.
  const untilEnd = window.end.getTime() - at.getTime();
  const extra = current >= rule.limit ? rule.windowSeconds * 1_000 : 0;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((untilEnd + extra) / 1_000)) };
}

/** Whether one more unit would be admitted, without consuming it. */
export function peekDecision(
  rule: RateLimitRule,
  window: RateLimitWindow,
  counts: { readonly previous: number; readonly current: number },
  at: Date,
): RateLimitDecision {
  const used = counts.previous + counts.current;
  return used < rule.limit ? admitted(rule, used) : denied(rule, window, counts.current, at);
}

/**
 * PLAN §11 network prefix: /24 for IPv4 and /56 for IPv6, as canonical text. Returns undefined for
 * anything that is not a literal IP address, so callers fail closed.
 */
export function networkPrefix(address: string): string | undefined {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  const candidate = mapped?.[1] ?? address;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(candidate);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (
      octets.some((octet) => octet > 255) ||
      ipv4.slice(1).some((octet) => octet.length > 1 && octet.startsWith('0'))
    ) {
      return undefined;
    }
    return `${octets.slice(0, 3).join('.')}.0/24`;
  }
  const groups = expandIpv6(address);
  if (!groups) return undefined;
  // /56 keeps the first three groups and the high byte of the fourth.
  const fourth = (groups[3] ?? 0) & 0xff00;
  return `${[...groups.slice(0, 3), fourth].map((group) => group.toString(16)).join(':')}::/56`;
}

function expandIpv6(address: string): number[] | undefined {
  if (!/^[0-9a-f:]{2,39}$/iu.test(address) || (address.match(/::/gu)?.length ?? 0) > 1)
    return undefined;
  const [head = '', tail] = address.split('::');
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (!left || !right) return undefined;
  if (tail === undefined) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}
