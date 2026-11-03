import type { SqlExecutor } from './runtime';

export type ContactChannel = 'PHONE';
export const PHONE_NORMALIZATION_PROFILE = 'e164-v1' as const;

export type PhoneNormalizationFailure =
  | 'INPUT_TOO_LONG'
  | 'INVALID_LENGTH'
  | 'NON_ASCII_DIGIT'
  | 'UNSUPPORTED_CHARACTER'
  | 'MISSING_CALLING_CODE'
  | 'UNSUPPORTED_REGION';

export interface CallingCodePolicy {
  readonly code: string; // ASCII digits, 1-3
  readonly nationalNumberLength: number;
  readonly destinationCodes?: readonly string[];
}

export interface PhoneNumberingPolicy {
  readonly defaultCallingCode?: string;
  readonly callingCodes: readonly CallingCodePolicy[];
}

export interface NormalizedPhone {
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly canonical: string; // never logged
}

export type PhoneNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedPhone }
  | { readonly ok: false; readonly code: PhoneNormalizationFailure };

export interface PhoneNormalizer {
  normalize(input: unknown): PhoneNormalizationResult;
}

export interface ContactFingerprint {
  readonly channel: ContactChannel;
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly keyVersion: string;
  readonly bytes: Buffer; // exactly 32
}

export interface ContactFingerprintSet {
  readonly primary: ContactFingerprint;
  readonly lookup: readonly ContactFingerprint[]; // includes primary
}

export interface ContactFingerprinter {
  fingerprint(value: NormalizedPhone): ContactFingerprintSet;
}

export type ContactPointState = 'ACTIVE' | 'REPLACED' | 'REVOKED';
export type ContactTransitionReason =
  'REGISTRATION' | 'RECOVERY' | 'CONTACT_CHANGE' | 'ACCOUNT_CLOSED';

export interface BindPrimaryContactCommand {
  readonly accountId: string;
  readonly phone: NormalizedPhone;
  readonly fingerprints: ContactFingerprintSet;
  readonly reason: 'REGISTRATION';
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface ReplacePrimaryContactCommand {
  readonly accountId: string;
  readonly expectedContactId: string;
  readonly phone: NormalizedPhone;
  readonly fingerprints: ContactFingerprintSet;
  readonly reason: 'RECOVERY' | 'CONTACT_CHANGE';
  readonly caseId: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export type ContactBindingResult =
  | { readonly kind: 'BOUND'; readonly contactId: string }
  | { readonly kind: 'CONTACT_ALREADY_BOUND' }
  | { readonly kind: 'STALE_CONTACT' };

/** Seals a phone that is not yet a contact point (SPEC-003 pending contact). */
export interface SealedPhone {
  readonly profile: typeof PHONE_NORMALIZATION_PROFILE;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer; // 12 bytes
  readonly tag: Buffer; // 16 bytes
  readonly wrappedKey: Buffer;
  readonly kekVersion: string;
}

export interface ContactEnvelopeSealer {
  /** AAD: trayvi.auth-pending-contact-envelope|v1|owner=<ownerId>|channel=PHONE|normalization=e164-v1 */
  seal(phone: NormalizedPhone, ownerId: string): Promise<SealedPhone>;
  /** Throws AuthKeyError or fails closed on any authentication failure. */
  open(sealed: SealedPhone, ownerId: string): Promise<NormalizedPhone>;
}

/** Implemented by ws-a. Every method runs inside the caller's transaction. */
export interface ContactPointCommands {
  bindPrimary(sql: SqlExecutor, command: BindPrimaryContactCommand): Promise<ContactBindingResult>;
  replacePrimary(
    sql: SqlExecutor,
    command: ReplacePrimaryContactCommand,
  ): Promise<ContactBindingResult>;
  findAccountByFingerprints(
    sql: SqlExecutor,
    fingerprints: ContactFingerprintSet,
  ): Promise<{ readonly accountId: string; readonly contactId: string } | undefined>;
  activePrimary(
    sql: SqlExecutor,
    accountId: string,
  ): Promise<{ readonly contactId: string; readonly phone: NormalizedPhone } | undefined>;
}
