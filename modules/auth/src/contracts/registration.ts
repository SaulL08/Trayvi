import type { ContactFingerprintSet, NormalizedPhone } from './contact';
import type { SqlExecutor } from './runtime';

// SPEC-002 design §2.1. Frozen before streams start.

export interface RegistrationContactReservations {
  reserve(
    sql: SqlExecutor,
    command: {
      readonly enrollmentOperationId: string;
      readonly proofId: string;
      readonly fingerprints: ContactFingerprintSet;
      readonly expiresAt: Date;
    },
  ): Promise<void>;
  /** Normalizes and fingerprints phoneInput, compares to the reservation, and deletes it. */
  claim(
    sql: SqlExecutor,
    command: { readonly enrollmentOperationId: string; readonly phoneInput: unknown },
  ): Promise<
    | {
        readonly kind: 'MATCHED';
        readonly phone: NormalizedPhone;
        readonly fingerprints: ContactFingerprintSet;
      }
    | { readonly kind: 'NO_MATCH' }
  >;
}
