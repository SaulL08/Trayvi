import type {
  BindPrimaryContactCommand,
  ContactBindingResult,
  ContactFingerprint,
  ContactFingerprintSet,
  ContactPointCommands,
  NormalizedPhone,
  ReplacePrimaryContactCommand,
} from '../../contracts/contact';
import type { IdGenerator, SqlExecutor } from '../../contracts/runtime';

import { buildContactEnvelopeAad, type ContactEnvelopeCipher } from './contact-protection';

type CommandOutcome = 'BOUND' | 'CONTACT_ALREADY_BOUND' | 'STALE_CONTACT';

export class ContactFingerprintSetError extends Error {
  constructor() {
    super('CONTACT_FINGERPRINT_SET_INVALID');
    this.name = 'ContactFingerprintSetError';
  }
}

/** Primary first, then every other lookup alias once; rejects an inconsistent set. */
function orderedFingerprints(set: ContactFingerprintSet): readonly ContactFingerprint[] {
  const others = set.lookup.filter((entry) => entry.keyVersion !== set.primary.keyVersion);
  const ordered = [set.primary, ...others];
  const versions = new Set(ordered.map((entry) => entry.keyVersion));
  if (
    versions.size !== ordered.length ||
    !set.lookup.some(
      (entry) =>
        entry.keyVersion === set.primary.keyVersion && entry.bytes.equals(set.primary.bytes),
    ) ||
    ordered.some(
      (entry) =>
        entry.channel !== 'PHONE' || entry.profile !== 'e164-v1' || entry.bytes.byteLength !== 32,
    )
  ) {
    throw new ContactFingerprintSetError();
  }
  return ordered;
}

function bindingResult(
  outcome: CommandOutcome | undefined,
  contactId: string,
): ContactBindingResult {
  if (outcome === 'BOUND') return { kind: 'BOUND', contactId };
  if (outcome === 'CONTACT_ALREADY_BOUND') return { kind: 'CONTACT_ALREADY_BOUND' };
  if (outcome === 'STALE_CONTACT') return { kind: 'STALE_CONTACT' };
  throw new Error('CONTACT_COMMAND_OUTCOME_INVALID');
}

/**
 * ws-a ContactPointCommands over the guarded `auth` commands (migration 0013). Every method runs
 * on the caller's SqlExecutor, so the binding commits or rolls back with the caller's transaction.
 */
export class PostgresContactPointCommands implements ContactPointCommands {
  readonly #cipher: ContactEnvelopeCipher;
  readonly #ids: IdGenerator;

  constructor(cipher: ContactEnvelopeCipher, ids: IdGenerator) {
    this.#cipher = cipher;
    this.#ids = ids;
  }

  async bindPrimary(
    sql: SqlExecutor,
    command: BindPrimaryContactCommand,
  ): Promise<ContactBindingResult> {
    const fingerprints = orderedFingerprints(command.fingerprints);
    const contactId = this.#ids.uuidV7();
    const envelope = this.#cipher.seal(command.phone, buildContactEnvelopeAad(contactId));
    const result = await sql.query<{ outcome: CommandOutcome }>(
      `SELECT auth.bind_primary_contact(
         $1, $2, $3::varchar[], $4::bytea[], $5::uuid[], $6, $7, $8, $9, $10, $11, $12, $13, $14
       ) AS outcome`,
      [
        contactId,
        command.accountId,
        fingerprints.map((entry) => entry.keyVersion),
        fingerprints.map((entry) => entry.bytes),
        fingerprints.map(() => this.#ids.uuidV7()),
        envelope.kekVersion,
        envelope.ciphertext,
        envelope.nonce,
        envelope.tag,
        envelope.wrappedDek,
        this.#ids.uuidV7(),
        this.#ids.uuidV7(),
        command.occurredAt,
        command.correlationId,
      ],
    );
    return bindingResult(result.rows[0]?.outcome, contactId);
  }

  async replacePrimary(
    sql: SqlExecutor,
    command: ReplacePrimaryContactCommand,
  ): Promise<ContactBindingResult> {
    const fingerprints = orderedFingerprints(command.fingerprints);
    const contactId = this.#ids.uuidV7();
    const envelope = this.#cipher.seal(command.phone, buildContactEnvelopeAad(contactId));
    const result = await sql.query<{ outcome: CommandOutcome }>(
      `SELECT auth.replace_primary_contact(
         $1, $2, $3, $4::varchar[], $5::bytea[], $6::uuid[], $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18
       ) AS outcome`,
      [
        contactId,
        command.accountId,
        command.expectedContactId,
        fingerprints.map((entry) => entry.keyVersion),
        fingerprints.map((entry) => entry.bytes),
        fingerprints.map(() => this.#ids.uuidV7()),
        envelope.kekVersion,
        envelope.ciphertext,
        envelope.nonce,
        envelope.tag,
        envelope.wrappedDek,
        command.reason,
        command.caseId,
        this.#ids.uuidV7(),
        this.#ids.uuidV7(),
        this.#ids.uuidV7(),
        command.occurredAt,
        command.correlationId,
      ],
    );
    return bindingResult(result.rows[0]?.outcome, contactId);
  }

  async findAccountByFingerprints(
    sql: SqlExecutor,
    fingerprints: ContactFingerprintSet,
  ): Promise<{ readonly accountId: string; readonly contactId: string } | undefined> {
    const lookup = orderedFingerprints(fingerprints);
    const result = await sql.query<{ account_id: string; contact_id: string }>(
      `SELECT contact.account_id, contact.id AS contact_id
       FROM unnest($1::varchar[], $2::bytea[]) AS candidate (key_version, fingerprint)
       JOIN auth.contact_point_fingerprints alias
         ON alias.channel = 'PHONE'
        AND alias.normalization_profile = 'e164-v1'
        AND alias.key_version = candidate.key_version
        AND alias.fingerprint = candidate.fingerprint
        AND alias.active
       JOIN auth.contact_points contact ON contact.id = alias.contact_id AND contact.state = 'ACTIVE'
       GROUP BY contact.account_id, contact.id`,
      [lookup.map((entry) => entry.keyVersion), lookup.map((entry) => entry.bytes)],
    );
    // The active unique index allows at most one contact per alias; two different contacts would
    // mean aliases of one number are split across accounts, which must fail closed.
    if (result.rows.length > 1) throw new Error('CONTACT_LOOKUP_AMBIGUOUS');
    const row = result.rows[0];
    return row ? { accountId: row.account_id, contactId: row.contact_id } : undefined;
  }

  async activePrimary(
    sql: SqlExecutor,
    accountId: string,
  ): Promise<{ readonly contactId: string; readonly phone: NormalizedPhone } | undefined> {
    const result = await sql.query<{
      contact_id: string;
      kek_key_version: string;
      ciphertext: Buffer;
      nonce: Buffer;
      authentication_tag: Buffer;
      wrapped_dek: Buffer;
    }>('SELECT * FROM auth.active_primary_contact_envelope($1)', [accountId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const phone = this.#cipher.open(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.authentication_tag,
        wrappedDek: row.wrapped_dek,
        kekVersion: row.kek_key_version,
      },
      buildContactEnvelopeAad(row.contact_id),
    );
    return { contactId: row.contact_id, phone };
  }
}
