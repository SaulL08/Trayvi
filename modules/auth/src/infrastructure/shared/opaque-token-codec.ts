import { createHash, randomBytes } from 'node:crypto';

import type { OpaqueTokenCodec, OpaqueTokenPrefix } from '../../contracts/tokens';
import type { RandomSource } from '../../contracts/runtime';

const TOKEN_BYTES = 32;
// base64url of 32 bytes without padding is exactly 43 characters.
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/u;
const PREFIXES: ReadonlySet<string> = new Set<OpaqueTokenPrefix>(['tvp_', 'tva_', 'tvr_', 'tvc_']);

const nodeRandom: RandomSource = { bytes: (length) => randomBytes(length) };

function sha256(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * PLAN §9.1 opaque tokens: prefix + base64url(32 CSPRNG bytes). Only SHA-256 of the token's UTF-8
 * bytes is ever stored; the token itself is returned once to the caller.
 */
export class NodeOpaqueTokenCodec implements OpaqueTokenCodec {
  readonly #random: RandomSource;

  constructor(random: RandomSource = nodeRandom) {
    this.#random = random;
  }

  issue(prefix: OpaqueTokenPrefix): { readonly token: string; readonly hash: Buffer } {
    if (!PREFIXES.has(prefix)) throw new TypeError('TOKEN_PREFIX_INVALID');
    const bytes = this.#random.bytes(TOKEN_BYTES);
    if (bytes.byteLength !== TOKEN_BYTES) throw new Error('TOKEN_ENTROPY_UNAVAILABLE');
    const token = `${prefix}${bytes.toString('base64url')}`;
    return { token, hash: sha256(token) };
  }

  hash(prefix: OpaqueTokenPrefix, candidate: unknown): Buffer | undefined {
    if (!PREFIXES.has(prefix) || typeof candidate !== 'string') return undefined;
    if (!candidate.startsWith(prefix)) return undefined;
    const body = candidate.slice(prefix.length);
    if (!TOKEN_BODY.test(body)) return undefined;
    // Reject non-canonical encodings (trailing bits set) so one token has exactly one spelling.
    if (Buffer.from(body, 'base64url').toString('base64url') !== body) return undefined;
    return sha256(candidate);
  }
}
