import { createHmac } from 'node:crypto';

import type { AuthKeyring } from '../../contracts/keys';
import type { SubjectCommitter, SubjectLabel } from '../../contracts/rate-limit';

export const SUBJECT_COMMITMENT_DOMAIN = 'trayvi.auth-subject';
const LABELS: ReadonlySet<string> = new Set<SubjectLabel>([
  'installation',
  'network-prefix',
  'contact',
  'account',
  'global',
]);
const MAX_VALUE_BYTES = 256;

/**
 * R-17: rate-limit buckets are keyed by HMAC-SHA-256 under the auth-subject-commitment key over
 * "trayvi.auth-subject\0<label>\0<value>", so stored rows reveal no phone number, address,
 * installation, or account. The label is fixed vocabulary, so values of one kind never collide
 * with another kind.
 */
export class HmacSubjectCommitter implements SubjectCommitter {
  readonly #keyring: AuthKeyring;

  constructor(keyring: AuthKeyring) {
    this.#keyring = keyring;
  }

  commit(label: SubjectLabel, value: string | Buffer): Buffer {
    if (!LABELS.has(label)) throw new TypeError('SUBJECT_LABEL_INVALID');
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_VALUE_BYTES) {
      throw new TypeError('SUBJECT_VALUE_INVALID');
    }
    return createHmac('sha256', this.#keyring.primary('auth-subject-commitment').material)
      .update(`${SUBJECT_COMMITMENT_DOMAIN}\0${label}\0`, 'utf8')
      .update(bytes)
      .digest();
  }
}
