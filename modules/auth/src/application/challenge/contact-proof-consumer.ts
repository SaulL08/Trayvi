import { timingSafeEqual } from 'node:crypto';

import type {
  ConsumeContactProofCommand,
  ConsumeContactProofResult,
  ContactProofConsumer,
} from '../../contracts/challenge';
import type { ContactFingerprinter, PhoneNormalizer } from '../../contracts/contact';
import type { SqlExecutor } from '../../contracts/runtime';
import type { OpaqueTokenCodec } from '../../contracts/tokens';
import { isProofExpired } from '../../domain/challenge/challenge-lifecycle';

import type { ChallengeStore } from './ports';

const REJECTED: ConsumeContactProofResult = { kind: 'PROOF_REJECTED' };

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * ws-b ContactProofConsumer (R-13, R-14). The caller re-enters the phone number because no
 * challenge stores it; consumption fails unless it fingerprints to the proven destination. Every
 * rejection returns the same result and writes nothing.
 */
export class DefaultContactProofConsumer implements ContactProofConsumer {
  readonly #normalizer: PhoneNormalizer;
  readonly #fingerprinter: ContactFingerprinter;
  readonly #tokens: OpaqueTokenCodec;
  readonly #store: ChallengeStore;

  constructor(
    normalizer: PhoneNormalizer,
    fingerprinter: ContactFingerprinter,
    tokens: OpaqueTokenCodec,
    store: ChallengeStore,
  ) {
    this.#normalizer = normalizer;
    this.#fingerprinter = fingerprinter;
    this.#tokens = tokens;
    this.#store = store;
  }

  async consume(
    sql: SqlExecutor,
    command: ConsumeContactProofCommand,
  ): Promise<ConsumeContactProofResult> {
    const proofHash = this.#tokens.hash('tvp_', command.proofToken);
    if (!proofHash) return REJECTED;
    const normalized = this.#normalizer.normalize(command.phoneInput);
    if (!normalized.ok) return REJECTED;
    const fingerprints = this.#fingerprinter.fingerprint(normalized.value);

    const proof = await this.#store.lockProof(sql, proofHash);
    if (
      !proof ||
      proof.consumedAt !== undefined ||
      proof.challengeState !== 'VERIFIED' ||
      proof.purpose !== command.purpose ||
      !sameBytes(proof.installationCommitment, command.installationCommitment) ||
      isProofExpired(proof.expiresAt, command.consumedAt) ||
      !fingerprints.lookup.some(
        (entry) =>
          entry.keyVersion === proof.destinationKeyVersion &&
          sameBytes(entry.bytes, proof.destinationFingerprint),
      )
    ) {
      return REJECTED;
    }
    if (!(await this.#store.consumeProof(sql, proof.id, proof.challengeId, command.consumedAt))) {
      return REJECTED;
    }
    return { kind: 'CONSUMED', proofId: proof.id, phone: normalized.value, fingerprints };
  }
}
