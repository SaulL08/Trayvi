import { describe, expect, it } from 'vitest';

import { parseAuthConfig } from '../../../../packages/config/src/index';
import type { RateLimitRule } from '../../src/contracts/rate-limit';
import {
  denied,
  networkPrefix,
  peekDecision,
  RATE_LIMIT_DIMENSIONS,
  RATE_LIMIT_WINDOWS,
  RateLimitPolicy,
  RateLimitPolicyError,
  windowFor,
} from '../../src/domain/rate-limit/rate-limit-policy';

const defaults = parseAuthConfig({}, 'test').rateLimits as readonly RateLimitRule[];

describe('PLAN §11 rate-limit rules', () => {
  it('accepts the configured PLAN defaults for every challenge, password, recovery, registration, and delivery dimension', () => {
    const policy = new RateLimitPolicy(defaults);
    expect(RATE_LIMIT_DIMENSIONS).toHaveLength(13);
    expect(policy.rule('CHALLENGE_START_CONTACT_HOUR')).toEqual({
      dimension: 'CHALLENGE_START_CONTACT_HOUR',
      limit: 5,
      windowSeconds: 3_600,
    });
    expect(policy.rule('CHALLENGE_START_CONTACT_DAY').limit).toBe(10);
    expect(policy.rule('CHALLENGE_START_NETWORK_HOUR').limit).toBe(30);
    expect(policy.rule('CHALLENGE_START_INSTALLATION_HOUR').limit).toBe(10);
    expect(policy.rule('CHALLENGE_VERIFY_FAILURE_CONTACT_DAY').limit).toBe(10);
    expect(policy.rule('PASSWORD_FAILURE_ACCOUNT')).toMatchObject({ limit: 5, windowSeconds: 900 });
    expect(policy.rule('RECOVERY_START_ACCOUNT_DAY').limit).toBe(3);
    expect(policy.rule('REGISTRATION_START_CONTACT_30D')).toMatchObject({
      limit: 3,
      windowSeconds: 2_592_000,
    });
    expect(policy.rule('REGISTRATION_START_NETWORK_DAY').limit).toBe(10);
    expect(policy.rule('DELIVERY_GLOBAL_MINUTE').windowSeconds).toBe(60);
    for (const rule of defaults)
      expect(rule.windowSeconds).toBe(RATE_LIMIT_WINDOWS[rule.dimension]);
  });

  it('honors configured limits and rejects a missing, duplicated, mis-windowed, or out-of-bounds rule', () => {
    const tuned = defaults.map((rule) =>
      rule.dimension === 'CHALLENGE_START_NETWORK_HOUR' ? { ...rule, limit: 99 } : rule,
    );
    expect(new RateLimitPolicy(tuned).rule('CHALLENGE_START_NETWORK_HOUR').limit).toBe(99);
    const invalid: readonly (readonly RateLimitRule[])[] = [
      defaults.slice(1),
      [...defaults, defaults[0] as RateLimitRule],
      defaults.map((rule, index) => (index === 0 ? { ...rule, windowSeconds: 60 } : rule)),
      defaults.map((rule, index) => (index === 0 ? { ...rule, limit: 0 } : rule)),
      defaults.map((rule, index) => (index === 0 ? { ...rule, limit: 100_001 } : rule)),
      defaults.map((rule, index) => (index === 0 ? { ...rule, limit: 1.5 } : rule)),
      [
        ...defaults.slice(1),
        { dimension: 'UNKNOWN' as RateLimitRule['dimension'], limit: 1, windowSeconds: 60 },
      ],
    ];
    for (const rules of invalid)
      expect(() => new RateLimitPolicy(rules)).toThrow(RateLimitPolicyError);
  });

  it('aligns windows to the epoch and counts the previous window', () => {
    const rule: RateLimitRule = {
      dimension: 'CHALLENGE_START_CONTACT_HOUR',
      limit: 5,
      windowSeconds: 3_600,
    };
    const at = new Date('2026-11-03T12:34:56.000Z');
    expect(windowFor(rule, at)).toEqual({
      start: new Date('2026-11-03T12:00:00.000Z'),
      previousStart: new Date('2026-11-03T11:00:00.000Z'),
      end: new Date('2026-11-03T13:00:00.000Z'),
    });
    const window = windowFor(rule, at);
    expect(peekDecision(rule, window, { previous: 2, current: 2 }, at)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(peekDecision(rule, window, { previous: 3, current: 2 }, at)).toEqual({
      allowed: false,
      retryAfterSeconds: 1_504,
    });
    // A current window that alone holds the limit also blocks the next window.
    expect(denied(rule, window, 5, at)).toEqual({
      allowed: false,
      retryAfterSeconds: 1_504 + 3_600,
    });
  });

  it('derives the PLAN /24 IPv4 and /56 IPv6 network prefixes and rejects non-addresses', () => {
    expect(networkPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(networkPrefix('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(networkPrefix('2001:db8:abcd:12ff::1')).toBe('2001:db8:abcd:1200::/56');
    expect(networkPrefix('2001:0db8:abcd:0012:0000:0000:0000:0001')).toBe('2001:db8:abcd:0::/56');
    expect(networkPrefix('::1')).toBe('0:0:0:0::/56');
    for (const invalid of [
      '256.1.1.1',
      '01.2.3.4',
      '1.2.3',
      'example.test',
      '2001:db8::1::2',
      '',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      expect(networkPrefix(invalid)).toBeUndefined();
    }
  });
});
