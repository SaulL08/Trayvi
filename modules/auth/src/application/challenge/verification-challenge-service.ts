import { timingSafeEqual } from 'node:crypto';

import type {
  ChallengePolicy,
  ContactAccountLookup,
  ResendChallengeCommand,
  ResendChallengeResult,
  StartChallengeCommand,
  StartChallengeResult,
  VerificationChallengeService,
  VerifyChallengeCommand,
  VerifyChallengeResult,
} from '../../contracts/challenge';
import type {
  ContactFingerprint,
  ContactFingerprinter,
  NormalizedPhone,
  PhoneNormalizer,
} from '../../contracts/contact';
import type { DeliveryOutcome, OtpDeliveryPort } from '../../contracts/delivery';
import type {
  RateLimitDecision,
  RateLimitDimension,
  RateLimiter,
  SubjectCommitter,
} from '../../contracts/rate-limit';
import type { Clock, IdGenerator, TransactionRunner } from '../../contracts/runtime';
import type { OpaqueTokenCodec } from '../../contracts/tokens';
import {
  CHALLENGE_PURPOSES,
  decideResend,
  decideVerify,
  isExpired,
  newChallengeTimes,
  proofExpiry,
  validateChallengePolicy,
  type ChallengeSnapshot,
} from '../../domain/challenge/challenge-lifecycle';

import type { ChallengeRecord, ChallengeStore, DeliveryOutcomeCode, OtpCodes } from './ports';

const INSERT_ATTEMPTS = 5;

export interface VerificationChallengeDependencies {
  readonly transactions: TransactionRunner;
  readonly normalizer: PhoneNormalizer;
  readonly fingerprinter: ContactFingerprinter;
  readonly subjects: SubjectCommitter;
  readonly rateLimiter: RateLimiter;
  readonly delivery: OtpDeliveryPort;
  readonly codes: OtpCodes;
  readonly tokens: OpaqueTokenCodec;
  readonly store: ChallengeStore;
  readonly accounts: ContactAccountLookup;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly policy: ChallengePolicy;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function snapshotOf(record: ChallengeRecord): ChallengeSnapshot {
  return {
    state: record.state,
    failedAttempts: record.failedAttempts,
    maxFailedAttempts: record.maxFailedAttempts,
    resendCount: record.resendCount,
    maxResends: record.maxResends,
    lastSentAt: record.lastSentAt,
    expiresAt: record.expiresAt,
  };
}

function outcomeCode(outcome: DeliveryOutcome): DeliveryOutcomeCode {
  return outcome.kind === 'SENT' ? 'SENT' : outcome.safeCode;
}

/**
 * ws-b VerificationChallengeService. Challenge start never reads account or contact-binding state
 * (R-21); network and installation limits answer RATE_LIMITED, while contact limits answer the same
 * ACCEPTED envelope and send nothing (R-19).
 */
export class DefaultVerificationChallengeService implements VerificationChallengeService {
  readonly #deps: VerificationChallengeDependencies;
  readonly #policy: ChallengePolicy;

  constructor(dependencies: VerificationChallengeDependencies) {
    this.#deps = dependencies;
    this.#policy = validateChallengePolicy(dependencies.policy);
  }

  async start(command: StartChallengeCommand): Promise<StartChallengeResult> {
    if (!CHALLENGE_PURPOSES.includes(command.purpose))
      throw new TypeError('CHALLENGE_PURPOSE_INVALID');
    const normalized = this.#deps.normalizer.normalize(command.phoneInput);
    if (!normalized.ok) return { kind: 'INVALID_CONTACT_FORMAT', code: normalized.code };
    const phone = normalized.value;
    const now = this.#deps.clock.now();

    const limited = await this.#clientLimits(command.client, now);
    if (limited) return limited;
    const destination = this.#deps.fingerprinter.fingerprint(phone).primary;
    const contactAllowed = await this.#contactStartAllowed(destination, now);

    const challengeId = this.#deps.ids.uuidV7();
    const times = newChallengeTimes(this.#policy, now);
    const accepted: StartChallengeResult = {
      kind: 'ACCEPTED',
      challengeId,
      expiresAt: times.expiresAt,
      resendAvailableAt: times.resendAvailableAt,
    };
    // Contact-limited: identical envelope, nothing stored, nothing sent, nothing cancelled.
    if (!contactAllowed) return accepted;

    const code = this.#deps.codes.generate();
    const committed = this.#deps.codes.commit(challengeId, command.purpose, code);
    await this.#deps.transactions.inTransaction(async (sql) => {
      for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt += 1) {
        // R-16: a newer challenge supersedes the PENDING one for the same destination and purpose.
        await this.#deps.store.cancelPending(
          sql,
          command.purpose,
          destination.keyVersion,
          destination.bytes,
          now,
        );
        const inserted = await this.#deps.store.insert(sql, {
          id: challengeId,
          purpose: command.purpose,
          destinationKeyVersion: destination.keyVersion,
          destinationFingerprint: destination.bytes,
          otpCommitment: committed.commitment,
          otpKeyVersion: committed.keyVersion,
          installationCommitment: command.client.installationCommitment,
          maxFailedAttempts: this.#policy.maxFailedAttempts,
          maxResends: this.#policy.maxResends,
          lastSentAt: now,
          expiresAt: times.expiresAt,
          createdAt: now,
        });
        if (inserted) return;
      }
      throw new Error('CHALLENGE_START_CONTENDED');
    });

    await this.#deliver(phone, command.client.locale, code, challengeId);
    return accepted;
  }

  async resend(command: ResendChallengeCommand): Promise<ResendChallengeResult> {
    const normalized = this.#deps.normalizer.normalize(command.phoneInput);
    if (!normalized.ok) return { kind: 'CHALLENGE_NOT_ACTIVE' };
    const phone = normalized.value;
    const now = this.#deps.clock.now();
    const limited = await this.#clientLimits(command.client, now);
    if (limited) return limited;
    const destination = this.#deps.fingerprinter.fingerprint(phone).primary;

    const outcome = await this.#deps.transactions.inTransaction(
      async (
        sql,
      ): Promise<
        | ResendChallengeResult
        | { readonly kind: 'SEND'; readonly code: string; readonly resendAvailableAt: Date }
      > => {
        const record = await this.#deps.store.lock(sql, command.challengeId);
        // Unknown challenge, other device, or a different number all look the same.
        if (
          !record ||
          !sameBytes(record.installationCommitment, command.client.installationCommitment) ||
          record.destinationKeyVersion !== destination.keyVersion ||
          !sameBytes(record.destinationFingerprint, destination.bytes)
        ) {
          return { kind: 'CHALLENGE_NOT_ACTIVE' };
        }
        const decision = decideResend(snapshotOf(record), this.#policy, now);
        if (decision.kind === 'NOT_ACTIVE') {
          if (decision.expire)
            await this.#deps.store.transition(sql, record.id, 'PENDING', 'EXPIRED', now);
          return { kind: 'CHALLENGE_NOT_ACTIVE' };
        }
        if (decision.kind === 'COOLDOWN') {
          return { kind: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds };
        }
        if (!(await this.#contactStartAllowed(destination, now))) {
          return { kind: 'ACCEPTED', resendAvailableAt: decision.resendAvailableAt };
        }
        // R-24: every send uses a fresh code; a retry never resends the previous one.
        const code = this.#deps.codes.generate();
        const committed = this.#deps.codes.commit(record.id, record.purpose, code);
        const updated = await this.#deps.store.recordResend(
          sql,
          record.id,
          committed.commitment,
          committed.keyVersion,
          now,
        );
        if (!updated) return { kind: 'CHALLENGE_NOT_ACTIVE' };
        return { kind: 'SEND', code, resendAvailableAt: decision.resendAvailableAt };
      },
    );
    if (outcome.kind !== 'SEND') return outcome;
    await this.#deliver(phone, command.client.locale, outcome.code, command.challengeId);
    return { kind: 'ACCEPTED', resendAvailableAt: outcome.resendAvailableAt };
  }

  async verify(command: VerifyChallengeCommand): Promise<VerifyChallengeResult> {
    const now = this.#deps.clock.now();
    const outcome = await this.#deps.transactions.inTransaction(
      async (
        sql,
      ): Promise<VerifyChallengeResult | { readonly kind: 'FAILED'; readonly subject: Buffer }> => {
        const record = await this.#deps.store.lock(sql, command.challengeId);
        if (
          !record ||
          !sameBytes(record.installationCommitment, command.client.installationCommitment)
        ) {
          return { kind: 'CHALLENGE_NOT_ACTIVE' };
        }
        const snapshot = snapshotOf(record);
        if (isExpired(snapshot, now)) {
          await this.#deps.store.transition(sql, record.id, 'PENDING', 'EXPIRED', now);
          return { kind: 'CHALLENGE_NOT_ACTIVE' };
        }
        if (record.state !== 'PENDING') return { kind: 'CHALLENGE_NOT_ACTIVE' };

        const subject = this.#deps.subjects.commit('contact', record.destinationFingerprint);
        const budget = await this.#deps.rateLimiter.peek(
          'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY',
          subject,
          now,
        );
        if (!budget.allowed)
          return { kind: 'RATE_LIMITED', retryAfterSeconds: budget.retryAfterSeconds };

        const matches = this.#deps.codes.matches(record.id, record.purpose, command.code, {
          commitment: record.otpCommitment,
          keyVersion: record.otpKeyVersion,
        });
        const decision = decideVerify(snapshot, now, matches);
        if (decision.kind === 'NOT_ACTIVE') return { kind: 'CHALLENGE_NOT_ACTIVE' };
        if (decision.kind === 'FAILED') {
          const counted = await this.#deps.store.recordFailure(sql, record.id, now);
          return counted ? { kind: 'FAILED', subject } : { kind: 'CHALLENGE_NOT_ACTIVE' };
        }

        if (!(await this.#deps.store.transition(sql, record.id, 'PENDING', 'VERIFIED', now))) {
          return { kind: 'CHALLENGE_NOT_ACTIVE' };
        }
        const proof = this.#deps.tokens.issue('tvp_');
        const proofExpiresAt = proofExpiry(this.#policy, now);
        await this.#deps.store.insertProof(sql, {
          id: this.#deps.ids.uuidV7(),
          challengeId: record.id,
          purpose: record.purpose,
          destinationKeyVersion: record.destinationKeyVersion,
          destinationFingerprint: record.destinationFingerprint,
          proofHash: proof.hash,
          installationCommitment: record.installationCommitment,
          createdAt: now,
          expiresAt: proofExpiresAt,
        });
        // Possession is the authorization to learn whether an account exists (PLAN §8.4).
        const fingerprint: ContactFingerprint = {
          channel: 'PHONE',
          profile: 'e164-v1',
          keyVersion: record.destinationKeyVersion,
          bytes: record.destinationFingerprint,
        };
        const accountExists =
          record.purpose === 'CONTACT_PROOF' &&
          (await this.#deps.accounts.exists(sql, { primary: fingerprint, lookup: [fingerprint] }));
        return { kind: 'VERIFIED', proofToken: proof.token, proofExpiresAt, accountExists };
      },
    );
    if (outcome.kind !== 'FAILED') return outcome;
    await this.#deps.rateLimiter.consume(
      'CHALLENGE_VERIFY_FAILURE_CONTACT_DAY',
      outcome.subject,
      now,
    );
    return { kind: 'VERIFICATION_FAILED' };
  }

  async #clientLimits(
    client: StartChallengeCommand['client'],
    now: Date,
  ): Promise<{ readonly kind: 'RATE_LIMITED'; readonly retryAfterSeconds: number } | undefined> {
    const decisions = [
      await this.#deps.rateLimiter.consume(
        'CHALLENGE_START_NETWORK_HOUR',
        client.networkCommitment,
        now,
      ),
      await this.#deps.rateLimiter.consume(
        'CHALLENGE_START_INSTALLATION_HOUR',
        client.installationCommitment,
        now,
      ),
    ];
    const denied = decisions.filter(
      (decision): decision is Extract<RateLimitDecision, { allowed: false }> => !decision.allowed,
    );
    if (denied.length === 0) return undefined;
    return {
      kind: 'RATE_LIMITED',
      retryAfterSeconds: Math.max(...denied.map((decision) => decision.retryAfterSeconds)),
    };
  }

  async #contactStartAllowed(destination: ContactFingerprint, now: Date): Promise<boolean> {
    const subject = this.#deps.subjects.commit('contact', destination.bytes);
    const dimensions: readonly RateLimitDimension[] = [
      'CHALLENGE_START_CONTACT_HOUR',
      'CHALLENGE_START_CONTACT_DAY',
    ];
    let allowed = true;
    for (const dimension of dimensions) {
      const decision = await this.#deps.rateLimiter.consume(dimension, subject, now);
      allowed &&= decision.allowed;
    }
    return allowed;
  }

  async #deliver(
    phone: NormalizedPhone,
    locale: string,
    code: string,
    challengeId: string,
  ): Promise<void> {
    let outcome: DeliveryOutcome;
    try {
      outcome = await this.#deps.delivery.send({
        destination: phone,
        template: 'OTP_CODE',
        locale,
        code,
        reference: challengeId,
      });
    } catch {
      // R-24: delivery failure never fails challenge start; only a safe code is recorded.
      outcome = { kind: 'NOT_SENT', safeCode: 'PROVIDER_UNAVAILABLE' };
    }
    await this.#deps.transactions.inTransaction((sql) =>
      this.#deps.store.recordDeliveryOutcome(
        sql,
        challengeId,
        outcomeCode(outcome),
        this.#deps.clock.now(),
      ),
    );
  }
}
