export interface TrustedVerificationRecord {
  readonly outcome: 'VERIFIED';
  readonly decisionId: string;
  readonly identityId: string;
  readonly caseId: string;
  readonly evidenceId: string;
  readonly reviewId: string;
  readonly identityTransitionId: string;
  readonly accountTransitionId: string;
  readonly outboxEventIds: readonly string[];
  readonly methodClass: string;
  readonly resultCode: string;
  readonly policyVersion: string;
  readonly providerAlias: string;
  readonly evidenceType: string;
  readonly evidenceDigest: Buffer;
  readonly restrictedEvidenceReference: string;
  readonly retentionClass: string;
  readonly actorReference: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export type TrustedVerificationOutcome = 'RECORDED' | 'REPLAY';

/**
 * Port for the trusted verification outcome handler. It is deliberately separate from
 * PhaseOneEnrollmentStore: enrollment runs as trayvi_runtime and verification as
 * trayvi_verification, so each adapter must be constructed over its own connection pool.
 */
export interface TrustedVerificationStore {
  recordTrustedVerification(input: TrustedVerificationRecord): Promise<TrustedVerificationOutcome>;
}

export type TrustedVerificationInput = Omit<
  TrustedVerificationRecord,
  | 'caseId'
  | 'evidenceId'
  | 'reviewId'
  | 'identityTransitionId'
  | 'accountTransitionId'
  | 'outboxEventIds'
  | 'occurredAt'
>;

export class TrustedVerificationService {
  readonly #store: TrustedVerificationStore;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;

  constructor(store: TrustedVerificationStore, idFactory: () => string, clock: () => Date) {
    this.#store = store;
    this.#idFactory = idFactory;
    this.#clock = clock;
  }

  async recordTrustedVerification(
    input: TrustedVerificationInput,
  ): Promise<TrustedVerificationOutcome> {
    const occurredAt = this.#clock();
    return this.#store.recordTrustedVerification({
      ...input,
      caseId: this.#idFactory(),
      evidenceId: this.#idFactory(),
      reviewId: this.#idFactory(),
      identityTransitionId: this.#idFactory(),
      accountTransitionId: this.#idFactory(),
      outboxEventIds: [this.#idFactory(), this.#idFactory()],
      occurredAt,
    });
  }
}
