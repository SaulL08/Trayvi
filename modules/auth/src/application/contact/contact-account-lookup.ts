import type { ContactAccountLookup } from '../../contracts/challenge';
import type { ContactFingerprintSet, ContactPointCommands } from '../../contracts/contact';
import type { SqlExecutor } from '../../contracts/runtime';

/** Read-only ContactAccountLookup for challenge verify(), wired to ContactPointCommands. */
export class ContactPointAccountLookup implements ContactAccountLookup {
  readonly #contacts: ContactPointCommands;

  constructor(contacts: ContactPointCommands) {
    this.#contacts = contacts;
  }

  async exists(sql: SqlExecutor, fingerprints: ContactFingerprintSet): Promise<boolean> {
    return (await this.#contacts.findAccountByFingerprints(sql, fingerprints)) !== undefined;
  }
}
