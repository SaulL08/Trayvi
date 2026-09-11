export type EnrollmentOperationStatus = 'STARTED' | 'COMPLETED' | 'CONFLICT' | 'EXPIRED';

export type EnrollmentPublicCode = 'ACCOUNT_CREATION_ACCEPTED' | 'IDENTITY_SUBMISSION_ACCEPTED';

export type EnrollmentInternalCode =
  | 'CLAIM_ALREADY_BLOCKING'
  | 'CLAIM_RACE_LOST'
  | 'IDEMPOTENT_REPLAY'
  | 'KEY_VERSION_UNAVAILABLE'
  | 'ENVELOPE_FAILURE';

export interface EnrollmentPublicResult {
  readonly operationId: string;
  readonly code: EnrollmentPublicCode;
  readonly nextStep: 'SUBMIT_IDENTITY' | 'CONTINUE_SECURELY';
}
