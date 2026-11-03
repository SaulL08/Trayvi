import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import {
  PHONE_NORMALIZATION_PROFILE,
  type ContactEnvelopeSealer,
  type ContactFingerprint,
  type ContactFingerprinter,
  type ContactFingerprintSet,
  type NormalizedPhone,
  type SealedPhone,
} from '../../contracts/contact';
import { AuthKeyError, type AuthKeyring, type VersionedKey } from '../../contracts/keys';
import type { RandomSource } from '../../contracts/runtime';

export const CONTACT_FINGERPRINT_DOMAIN = 'trayvi.auth-contact-fingerprint';
export const CONTACT_ENVELOPE_DOMAIN = 'trayvi.auth-contact-envelope';
export const PENDING_CONTACT_ENVELOPE_DOMAIN = 'trayvi.auth-pending-contact-envelope';
const DEK_WRAP_DOMAIN = 'trayvi.auth-contact-dek-wrap';
const ENVELOPE_VERSION = 'v1';
const CHANNEL = 'PHONE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_PHONE = /^\+[0-9]{8,15}$/u;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
/** nonce (12) | tag (16) | ciphertext (32), as in the Phase 1 document KEK wrap. */
export const WRAPPED_DEK_BYTES = NONCE_BYTES + TAG_BYTES + DEK_BYTES;

const nodeRandom: RandomSource = { bytes: (length) => randomBytes(length) };

/** Fails closed on any envelope problem; the code never carries plaintext or key material. */
export class ContactProtectionError extends Error {
  readonly code: 'CONTACT_ENVELOPE_INVALID' | 'CONTACT_OWNER_INVALID';

  constructor(code: 'CONTACT_ENVELOPE_INVALID' | 'CONTACT_OWNER_INVALID') {
    super(code);
    this.name = 'ContactProtectionError';
    this.code = code;
  }
}

function assertCanonical(phone: NormalizedPhone): void {
  if (phone.profile !== PHONE_NORMALIZATION_PROFILE || !CANONICAL_PHONE.test(phone.canonical)) {
    throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
  }
}

function assertOwner(ownerId: string): void {
  // A UUID cannot contain the "|" separator, so the AAD stays unambiguous.
  if (!UUID.test(ownerId)) throw new ContactProtectionError('CONTACT_OWNER_INVALID');
}

/** PLAN §7.1: HMAC-SHA-256 over NUL-joined domain, profile, channel, canonical value. */
export function computeContactFingerprint(key: Buffer, phone: NormalizedPhone): Buffer {
  return createHmac('sha256', key)
    .update(
      [CONTACT_FINGERPRINT_DOMAIN, phone.profile, CHANNEL, phone.canonical].join('\0'),
      'utf8',
    )
    .digest();
}

export function buildContactEnvelopeAad(contactId: string): Buffer {
  assertOwner(contactId);
  return Buffer.from(
    `${CONTACT_ENVELOPE_DOMAIN}|${ENVELOPE_VERSION}|contact=${contactId}|channel=${CHANNEL}|normalization=${PHONE_NORMALIZATION_PROFILE}`,
    'utf8',
  );
}

export function buildPendingContactEnvelopeAad(ownerId: string): Buffer {
  assertOwner(ownerId);
  return Buffer.from(
    `${PENDING_CONTACT_ENVELOPE_DOMAIN}|${ENVELOPE_VERSION}|owner=${ownerId}|channel=${CHANNEL}|normalization=${PHONE_NORMALIZATION_PROFILE}`,
    'utf8',
  );
}

/** AES-256-GCM of the canonical value under a DEK (PLAN §7.2 vector layer). */
export function encryptContactValue(
  dek: Buffer,
  nonce: Buffer,
  aad: Buffer,
  canonical: string,
): { readonly ciphertext: Buffer; readonly tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(canonical, 'utf8'), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

/** Inverse of encryptContactValue; throws ContactProtectionError on any authentication failure. */
export function decryptContactValue(
  dek: Buffer,
  parts: { readonly nonce: Buffer; readonly tag: Buffer; readonly ciphertext: Buffer },
  aad: Buffer,
): NormalizedPhone {
  try {
    if (parts.nonce.byteLength !== NONCE_BYTES || parts.tag.byteLength !== TAG_BYTES) {
      throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
    }
    const decipher = createDecipheriv('aes-256-gcm', dek, parts.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    const plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    const phone: NormalizedPhone = Object.freeze({
      profile: PHONE_NORMALIZATION_PROFILE,
      canonical: plaintext.toString('utf8'),
    });
    assertCanonical(phone);
    return phone;
  } catch (error: unknown) {
    if (error instanceof ContactProtectionError) throw error;
    throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
  }
}

export class HmacContactFingerprinter implements ContactFingerprinter {
  readonly #keyring: AuthKeyring;

  constructor(keyring: AuthKeyring) {
    this.#keyring = keyring;
  }

  fingerprint(value: NormalizedPhone): ContactFingerprintSet {
    assertCanonical(value);
    const lookup: ContactFingerprint[] = this.#keyring
      .active('auth-contact-fingerprint')
      .map((key) => ({
        channel: CHANNEL,
        profile: PHONE_NORMALIZATION_PROFILE,
        keyVersion: key.version,
        bytes: computeContactFingerprint(key.material, value),
      }));
    const [primary] = lookup;
    if (!primary) throw new AuthKeyError('KEY_UNAVAILABLE');
    return { primary, lookup };
  }
}

export interface ContactEnvelope {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly kekVersion: string;
}

/**
 * PLAN §7.2 AES-256-GCM envelope with a per-record DEK wrapped by the Auth KEK. The KEK wrap uses
 * the reviewed Phase 1 construction with an Auth-specific domain and separate keys (ADR-013).
 */
export class ContactEnvelopeCipher {
  readonly #keyring: AuthKeyring;
  readonly #random: RandomSource;

  constructor(keyring: AuthKeyring, random: RandomSource = nodeRandom) {
    this.#keyring = keyring;
    this.#random = random;
  }

  seal(phone: NormalizedPhone, aad: Buffer): ContactEnvelope {
    assertCanonical(phone);
    const dek = this.#bytes(DEK_BYTES);
    const nonce = this.#bytes(NONCE_BYTES);
    try {
      const { ciphertext, tag } = encryptContactValue(dek, nonce, aad, phone.canonical);
      const kek = this.#keyring.primary('auth-contact-kek');
      return {
        ciphertext,
        nonce,
        tag,
        wrappedDek: this.#wrap(dek, kek),
        kekVersion: kek.version,
      };
    } finally {
      dek.fill(0);
    }
  }

  open(envelope: ContactEnvelope, aad: Buffer): NormalizedPhone {
    const dek = this.#unwrap(envelope.wrappedDek, envelope.kekVersion);
    try {
      return decryptContactValue(dek, envelope, aad);
    } finally {
      dek.fill(0);
    }
  }

  #bytes(length: number): Buffer {
    const bytes = this.#random.bytes(length);
    if (bytes.byteLength !== length) throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
    return bytes;
  }

  #wrap(dek: Buffer, kek: VersionedKey): Buffer {
    const nonce = this.#bytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek.material, nonce);
    cipher.setAAD(Buffer.from(`${DEK_WRAP_DOMAIN}\0${kek.version}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  #unwrap(wrappedDek: Buffer, kekVersion: string): Buffer {
    // Only primary and lookup-active KEKs can open; a retired version is unavailable.
    const kek = this.#keyring.active('auth-contact-kek').find((key) => key.version === kekVersion);
    if (!kek) throw new AuthKeyError('KEY_UNAVAILABLE');
    if (wrappedDek.byteLength !== WRAPPED_DEK_BYTES) {
      throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        kek.material,
        wrappedDek.subarray(0, NONCE_BYTES),
      );
      decipher.setAAD(Buffer.from(`${DEK_WRAP_DOMAIN}\0${kek.version}`, 'utf8'));
      decipher.setAuthTag(wrappedDek.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(wrappedDek.subarray(NONCE_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
    }
  }
}

/** SPEC-003 pending contacts: the same envelope, bound to an owner (for example a recovery case). */
export class NodeContactEnvelopeSealer implements ContactEnvelopeSealer {
  readonly #cipher: ContactEnvelopeCipher;

  constructor(cipher: ContactEnvelopeCipher) {
    this.#cipher = cipher;
  }

  seal(phone: NormalizedPhone, ownerId: string): Promise<SealedPhone> {
    const envelope = this.#cipher.seal(phone, buildPendingContactEnvelopeAad(ownerId));
    return Promise.resolve({
      profile: PHONE_NORMALIZATION_PROFILE,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      tag: envelope.tag,
      wrappedKey: envelope.wrappedDek,
      kekVersion: envelope.kekVersion,
    });
  }

  open(sealed: SealedPhone, ownerId: string): Promise<NormalizedPhone> {
    try {
      if (sealed.profile !== PHONE_NORMALIZATION_PROFILE) {
        throw new ContactProtectionError('CONTACT_ENVELOPE_INVALID');
      }
      return Promise.resolve(
        this.#cipher.open(
          {
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            tag: sealed.tag,
            wrappedDek: sealed.wrappedKey,
            kekVersion: sealed.kekVersion,
          },
          buildPendingContactEnvelopeAad(ownerId),
        ),
      );
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error('CONTACT_ENVELOPE_INVALID'));
    }
  }
}
