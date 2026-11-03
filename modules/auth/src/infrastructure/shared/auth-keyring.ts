import { timingSafeEqual } from 'node:crypto';

import {
  AUTH_KEY_PURPOSES,
  AUTH_KEY_VERSION_PATTERN,
  AuthKeyError,
  type AuthKeyPurpose,
  type AuthKeyring,
  type VersionedKey,
} from '../../contracts/keys';

const KEY_BYTES = 32;

export interface AuthKeyringOptions {
  /**
   * Key material of every other configured purpose outside Auth (for example Identity's document
   * fingerprint, KEK, and idempotency keys). Sharing bytes with any of them fails startup.
   */
  readonly foreignKeyMaterial?: readonly Buffer[];
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * Validated, immutable Auth keyring. Construction fails closed with an AuthKeyError whose message
 * is only the code, so no purpose, version, or key byte reaches logs.
 */
export class ConfiguredAuthKeyring implements AuthKeyring {
  readonly #byPurpose: ReadonlyMap<AuthKeyPurpose, readonly VersionedKey[]>;

  constructor(keys: readonly VersionedKey[], options: AuthKeyringOptions = {}) {
    const copies: VersionedKey[] = [];
    for (const key of keys) {
      if (
        !(AUTH_KEY_PURPOSES as readonly string[]).includes(key.purpose) ||
        !AUTH_KEY_VERSION_PATTERN.test(key.version) ||
        !['PRIMARY', 'LOOKUP_ACTIVE', 'RETIRED'].includes(key.state) ||
        !Buffer.isBuffer(key.material) ||
        key.material.byteLength !== KEY_BYTES
      ) {
        throw new AuthKeyError('KEY_INVALID');
      }
      copies.push(
        Object.freeze({ ...key, material: Buffer.from(key.material) }) satisfies VersionedKey,
      );
    }

    for (const [index, key] of copies.entries()) {
      for (const other of copies.slice(index + 1)) {
        if (key.purpose === other.purpose && key.version === other.version) {
          throw new AuthKeyError('KEY_INVALID');
        }
        if (sameBytes(key.material, other.material)) {
          throw new AuthKeyError(
            key.purpose === other.purpose ? 'KEY_INVALID' : 'KEY_PURPOSE_COLLISION',
          );
        }
      }
      for (const foreign of options.foreignKeyMaterial ?? []) {
        if (sameBytes(key.material, foreign)) throw new AuthKeyError('KEY_PURPOSE_COLLISION');
      }
    }

    const byPurpose = new Map<AuthKeyPurpose, readonly VersionedKey[]>();
    for (const purpose of AUTH_KEY_PURPOSES) {
      const forPurpose = copies.filter((key) => key.purpose === purpose);
      const primaries = forPurpose.filter((key) => key.state === 'PRIMARY');
      if (primaries.length !== 1) throw new AuthKeyError('KEY_UNAVAILABLE');
      const lookup = forPurpose
        .filter((key) => key.state === 'LOOKUP_ACTIVE')
        .sort((left, right) => (left.version < right.version ? -1 : 1));
      byPurpose.set(purpose, Object.freeze([...primaries, ...lookup]));
    }
    this.#byPurpose = byPurpose;
  }

  active(purpose: AuthKeyPurpose): readonly VersionedKey[] {
    const keys = this.#byPurpose.get(purpose);
    if (!keys || keys.length === 0) throw new AuthKeyError('KEY_UNAVAILABLE');
    return keys;
  }

  primary(purpose: AuthKeyPurpose): VersionedKey {
    const [primary] = this.active(purpose);
    if (!primary) throw new AuthKeyError('KEY_UNAVAILABLE');
    return primary;
  }

  toJSON(): string {
    return '[AuthKeyring]';
  }
}
