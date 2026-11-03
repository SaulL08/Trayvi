import { describe, expect, it } from 'vitest';

import { GuardedOtpDeliveryPort } from '../../src/application/delivery/guarded-delivery-port';
import type { DeliveryOutcome, DeliveryRequest } from '../../src/contracts/delivery';
import type { RateLimitDecision, RateLimiter } from '../../src/contracts/rate-limit';
import { DeliveryRequestError } from '../../src/domain/delivery/delivery-request';
import { SyntheticDeliveryTransport } from '../../src/infrastructure/delivery/synthetic-delivery';

const canaryPhone = '+18095550142';
const canaryCode = '731905';
const request: DeliveryRequest = {
  destination: { profile: 'e164-v1', canonical: canaryPhone },
  template: 'OTP_CODE',
  locale: 'es-DO',
  code: canaryCode,
  reference: '018f0000-0000-7000-8000-0000000000a1',
};

class BudgetLimiter implements RateLimiter {
  calls = 0;
  constructor(private readonly budget: number) {}

  consume(): Promise<RateLimitDecision> {
    this.calls += 1;
    return Promise.resolve(
      this.calls <= this.budget
        ? { allowed: true, remaining: this.budget - this.calls }
        : { allowed: false, retryAfterSeconds: 30 },
    );
  }

  peek(): Promise<RateLimitDecision> {
    return Promise.resolve({ allowed: true, remaining: this.budget });
  }
}

function port(
  transport: SyntheticDeliveryTransport,
  limiter: RateLimiter = new BudgetLimiter(100),
  timeoutMs = 3_000,
) {
  return new GuardedOtpDeliveryPort({
    transport,
    rateLimiter: limiter,
    budgetSubject: Buffer.alloc(32, 7),
    clock: { now: () => new Date('2026-11-03T12:00:00.000Z') },
    timeoutMs,
  });
}

function assertNoCanary(value: unknown): void {
  const serialized = JSON.stringify(value, (_key, entry: unknown) =>
    entry instanceof Error ? { message: entry.message, name: entry.name } : entry,
  );
  expect(serialized).not.toContain(canaryPhone);
  expect(serialized).not.toContain(canaryPhone.slice(1));
  expect(serialized).not.toContain(canaryCode);
}

describe('synthetic OTP delivery (R-23, R-24)', () => {
  it('hands the code and destination to the provider in memory and returns only safe identifiers', async () => {
    const transport = new SyntheticDeliveryTransport();
    const outcome = await port(transport).send(request);
    expect(outcome.kind).toBe('SENT');
    if (outcome.kind !== 'SENT') return;
    expect(outcome.providerAlias).toBe('synthetic');
    expect(outcome.providerMessageId).toMatch(/^syn-[0-9a-f-]{36}$/u);
    assertNoCanary(outcome);
    assertNoCanary(transport);
    expect(transport.messages()).toHaveLength(1);
    expect(transport.messages()[0]?.request).toEqual(request);
  });

  it('spends the global budget before calling the provider and stops when it is exhausted', async () => {
    const transport = new SyntheticDeliveryTransport();
    const limiter = new BudgetLimiter(2);
    const delivery = port(transport, limiter);
    const outcomes: DeliveryOutcome[] = [];
    for (let index = 0; index < 4; index += 1) outcomes.push(await delivery.send(request));
    expect(
      outcomes.map((outcome) => (outcome.kind === 'SENT' ? 'SENT' : outcome.safeCode)),
    ).toEqual(['SENT', 'SENT', 'BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED']);
    expect(transport.messages()).toHaveLength(2);
    expect(limiter.calls).toBe(4);
  });

  it('maps a rejection, an unavailable provider, and a timeout to safe codes without the request content', async () => {
    const transport = new SyntheticDeliveryTransport();
    const cases: readonly (readonly [SyntheticDeliveryTransport['behavior'], string])[] = [
      ['REJECT', 'PROVIDER_REJECTED'],
      ['FAIL', 'PROVIDER_UNAVAILABLE'],
      ['HANG', 'TIMEOUT'],
    ];
    for (const [behavior, safeCode] of cases) {
      transport.behavior = behavior;
      const outcome = await port(transport, new BudgetLimiter(100), 20).send(request);
      expect(outcome).toEqual({ kind: 'NOT_SENT', safeCode });
      assertNoCanary(outcome);
    }
    expect(transport.messages()).toHaveLength(0);
  });

  it('rejects malformed requests with an error that carries no content', async () => {
    const delivery = port(new SyntheticDeliveryTransport());
    const invalid: readonly DeliveryRequest[] = [
      { ...request, code: '12345' },
      { ...request, template: 'SECURITY_NOTICE_NEW_SESSION' },
      { ...request, destination: { profile: 'e164-v1', canonical: '8095550142' } },
      { ...request, reference: 'challenge-1' },
      { ...request, locale: 'es_DO' },
    ];
    for (const candidate of invalid) {
      const error = await delivery.send(candidate).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(DeliveryRequestError);
      assertNoCanary(error);
    }
    const notice: DeliveryRequest = {
      destination: request.destination,
      template: 'SECURITY_NOTICE_NEW_SESSION',
      locale: request.locale,
      reference: request.reference,
    };
    await expect(delivery.send(notice)).resolves.toMatchObject({ kind: 'SENT' });
  });
});
