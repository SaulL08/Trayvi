import { Pool } from 'pg';

import {
  ConfiguredAuthKeyring,
  ContactEnvelopeCipher,
  ContactPointAccountLookup,
  DefaultVerificationChallengeService,
  DeliveryStatusCallbackHandler,
  E164PhoneNormalizer,
  GuardedOtpDeliveryPort,
  HmacContactFingerprinter,
  HmacSubjectCommitter,
  KeyedOtpCommitter,
  NodeOpaqueTokenCodec,
  PostgresCallbackReceiptStore,
  PostgresChallengeStore,
  PostgresContactPointCommands,
  PostgresRateLimiter,
  RateLimitPolicy,
  RejectionSamplingOtpGenerator,
  SignedCallbackIngress,
  SyntheticDeliveryTransport,
  type CallbackIngress,
  type Clock,
  type IdGenerator,
  type SubjectCommitter,
  type VerificationChallengeService,
} from '@trayvi/auth';
import type { AppConfig, AuthConfig } from '@trayvi/config';
import { createOpaqueId } from '@trayvi/observability';

import { poolExecutor, poolTransactions } from './postgres-runtime';
import { syntheticAuthKeys } from './synthetic-keys';

export interface AuthServices {
  readonly challenges: VerificationChallengeService;
  readonly callbacks: CallbackIngress;
  readonly subjects: SubjectCommitter;
  /** Synthetic provider outbox; tests read delivered codes from it. */
  readonly transport: SyntheticDeliveryTransport;
  readonly maxCallbackBodyBytes: number;
  close(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };
const ids: IdGenerator = { uuidV7: createOpaqueId };

/**
 * SPEC-001 composition root: the real ws-a..ws-d implementations over one runtime pool. Challenge
 * and contact writes run in their own transactions; rate-limit buckets use autocommit statements.
 */
export function composeAuthServices(config: AppConfig, auth: AuthConfig): AuthServices {
  const pool = new Pool({
    connectionString: config.database.url,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    statement_timeout: 10_000,
    ssl:
      config.database.tls.mode === 'verify-full'
        ? {
            rejectUnauthorized: config.database.tls.rejectUnauthorized,
            ...(config.database.tls.ca ? { ca: config.database.tls.ca } : {}),
          }
        : false,
  });
  // Pool errors on idle clients must not crash the process; requests fail closed instead.
  pool.on('error', () => undefined);

  const keyring = new ConfiguredAuthKeyring(syntheticAuthKeys());
  const normalizer = new E164PhoneNormalizer(auth.numbering);
  const fingerprinter = new HmacContactFingerprinter(keyring);
  const subjects = new HmacSubjectCommitter(keyring);
  const rateLimiter = new PostgresRateLimiter(
    poolExecutor(pool),
    new RateLimitPolicy(auth.rateLimits),
  );
  const transport = new SyntheticDeliveryTransport();
  const delivery = new GuardedOtpDeliveryPort({
    transport,
    rateLimiter,
    budgetSubject: subjects.commit('global', 'delivery'),
    clock: systemClock,
    timeoutMs: auth.delivery.timeoutMs,
  });
  const committer = new KeyedOtpCommitter(keyring);
  const generator = new RejectionSamplingOtpGenerator();
  const transactions = poolTransactions(pool);
  const contacts = new PostgresContactPointCommands(new ContactEnvelopeCipher(keyring), ids);

  const challenges = new DefaultVerificationChallengeService({
    transactions,
    normalizer,
    fingerprinter,
    subjects,
    rateLimiter,
    delivery,
    codes: {
      generate: () => generator.generate(),
      commit: (challengeId, purpose, code) => committer.commit(challengeId, purpose, code),
      matches: (challengeId, purpose, candidate, stored) =>
        committer.matches(challengeId, purpose, candidate, stored),
    },
    tokens: new NodeOpaqueTokenCodec(),
    store: new PostgresChallengeStore(),
    accounts: new ContactPointAccountLookup(contacts),
    ids,
    clock: systemClock,
    policy: auth.challenge,
  });

  const callbacks = new SignedCallbackIngress({
    transactions,
    providers: auth.callbacks.providers,
    handlers: [new DeliveryStatusCallbackHandler()],
    receipts: new PostgresCallbackReceiptStore(),
    ids,
    maxBodyBytes: auth.callbacks.maxBodyBytes,
    timestampToleranceSeconds: auth.callbacks.timestampToleranceSeconds,
  });

  return {
    challenges,
    callbacks,
    subjects,
    transport,
    maxCallbackBodyBytes: auth.callbacks.maxBodyBytes,
    close: () => pool.end(),
  };
}
