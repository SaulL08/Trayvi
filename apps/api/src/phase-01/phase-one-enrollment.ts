import type { EnrollmentPublicResult } from '@trayvi/accounts';
import {
  DocumentNormalizationError,
  DocumentProtectionError,
  type NodeIdentityDocumentProtector,
  type ProtectedIdentityDocument,
} from '@trayvi/identity';

import { SafePublicError } from '../http/safe-public-error';

export type EnrollmentCheckpoint =
  | 'ACCOUNT_INSERTED'
  | 'IDENTITY_INSERTED'
  | 'DOCUMENT_ENVELOPE_INSERTED'
  | 'FINGERPRINT_CLAIMS_INSERTED'
  | 'TRANSITION_HISTORY_INSERTED'
  | 'OUTBOX_INSERTED'
  | 'IDEMPOTENCY_RESULT_RECORDED';

export interface EnrollmentMutationProbe {
  checkpoint(checkpoint: EnrollmentCheckpoint): Promise<void>;
}

export interface StartEnrollmentRecord {
  readonly operationId: string;
  readonly callerBindingCommitment: Buffer;
  readonly idempotencyKeyCommitment: Buffer;
  readonly requestCommitment: Buffer;
  readonly requestCommitmentKeyVersion: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type StartEnrollmentStoreResult =
  | { readonly kind: 'ACCEPTED'; readonly operationId: string; readonly submitted: boolean }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

export interface SubmitEnrollmentRecord {
  readonly operationId: string;
  readonly accountId: string;
  readonly identityId: string;
  readonly documentId: string;
  readonly accountTransitionId: string;
  readonly identityTransitionId: string;
  readonly claimIds: readonly string[];
  readonly outboxEventIds: readonly string[];
  readonly protectedDocument: ProtectedIdentityDocument;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId?: string;
}

export type SubmitEnrollmentStoreResult =
  | { readonly kind: 'ACCEPTED' }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'UNAVAILABLE' };

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

export interface PhaseOneEnrollmentStore {
  start(input: StartEnrollmentRecord): Promise<StartEnrollmentStoreResult>;
  submit(input: SubmitEnrollmentRecord): Promise<SubmitEnrollmentStoreResult>;
  recordTrustedVerification(input: TrustedVerificationRecord): Promise<'RECORDED' | 'REPLAY'>;
}

export interface StartAccountCreationInput {
  readonly callerBinding: string;
  readonly idempotencyKey: string;
  readonly channel: string;
  readonly locale: string;
}

export interface SubmitIdentityInformationInput {
  readonly operationId: string;
  readonly documentValue: unknown;
  readonly correlationId: string;
  readonly causationId?: string;
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

export interface PhaseOneEnrollmentOptions {
  readonly operationTtlMs?: number;
}

export class PhaseOneEnrollmentService {
  readonly #store: PhaseOneEnrollmentStore;
  readonly #protector: NodeIdentityDocumentProtector;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #operationTtlMs: number;

  constructor(
    store: PhaseOneEnrollmentStore,
    protector: NodeIdentityDocumentProtector,
    idFactory: () => string,
    clock: () => Date,
    options: PhaseOneEnrollmentOptions = {},
  ) {
    this.#store = store;
    this.#protector = protector;
    this.#idFactory = idFactory;
    this.#clock = clock;
    this.#operationTtlMs = options.operationTtlMs ?? 30 * 60 * 1_000;
  }

  async startAccountCreation(input: StartAccountCreationInput): Promise<EnrollmentPublicResult> {
    if (
      [input.callerBinding, input.idempotencyKey, input.channel, input.locale].some(
        (value) => value.length === 0 || value.length > 128,
      )
    ) {
      throw new SafePublicError('REQUEST_CANNOT_BE_COMPLETED');
    }
    const caller = this.#protector.commitNonDocumentRequest('caller-binding.v1', [
      input.callerBinding,
    ]);
    const idempotency = this.#protector.commitNonDocumentRequest('idempotency-key.v1', [
      input.idempotencyKey,
    ]);
    const request = this.#protector.commitNonDocumentRequest('start-account.v1', [
      input.channel,
      input.locale,
    ]);
    const createdAt = this.#clock();
    const result = await this.#store.start({
      operationId: this.#idFactory(),
      callerBindingCommitment: caller.value,
      idempotencyKeyCommitment: idempotency.value,
      requestCommitment: request.value,
      requestCommitmentKeyVersion: request.keyVersion,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.#operationTtlMs),
    });
    if (result.kind === 'IDEMPOTENCY_CONFLICT') {
      throw new SafePublicError('IDEMPOTENCY_CONFLICT');
    }
    return {
      operationId: result.operationId,
      code: result.submitted ? 'IDENTITY_SUBMISSION_ACCEPTED' : 'ACCOUNT_CREATION_ACCEPTED',
      nextStep: result.submitted ? 'CONTINUE_SECURELY' : 'SUBMIT_IDENTITY',
    };
  }

  async submitIdentityInformation(
    input: SubmitIdentityInformationInput,
  ): Promise<EnrollmentPublicResult> {
    const accountId = this.#idFactory();
    const identityId = this.#idFactory();
    const documentId = this.#idFactory();
    let protectedDocument: ProtectedIdentityDocument;
    try {
      protectedDocument = await this.#protector.protect({
        identityId,
        documentId,
        countryCode: 'DO',
        issuerCode: 'JCE',
        documentType: 'NATIONAL_ID',
        documentValue: input.documentValue,
      });
    } catch (error: unknown) {
      if (error instanceof DocumentNormalizationError) {
        throw new SafePublicError('INVALID_IDENTITY_DOCUMENT_FORMAT');
      }
      if (error instanceof DocumentProtectionError) {
        throw new SafePublicError('REQUEST_CANNOT_BE_COMPLETED');
      }
      throw error;
    }

    const result = await this.#store.submit({
      operationId: input.operationId,
      accountId,
      identityId,
      documentId,
      accountTransitionId: this.#idFactory(),
      identityTransitionId: this.#idFactory(),
      claimIds: protectedDocument.fingerprintAliases.map(() => this.#idFactory()),
      outboxEventIds: [this.#idFactory(), this.#idFactory(), this.#idFactory()],
      protectedDocument,
      occurredAt: this.#clock(),
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
    });
    if (result.kind === 'IDEMPOTENCY_CONFLICT') {
      throw new SafePublicError('IDEMPOTENCY_CONFLICT');
    }
    if (result.kind === 'UNAVAILABLE') {
      throw new SafePublicError('REQUEST_CANNOT_BE_COMPLETED');
    }
    return {
      operationId: input.operationId,
      code: 'IDENTITY_SUBMISSION_ACCEPTED',
      nextStep: 'CONTINUE_SECURELY',
    };
  }

  async recordTrustedVerification(input: TrustedVerificationInput): Promise<'RECORDED' | 'REPLAY'> {
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
