import { readFile } from 'node:fs/promises';

import type { CompromisedPasswordChecker } from '../../contracts/password';

/**
 * Phase 2 synthetic list (PLAN §10). Production replaces it with a reviewed breach corpus through
 * AUTH_COMPROMISED_PASSWORD_LIST_PATH; no network call is made.
 */
export const SYNTHETIC_COMPROMISED_PASSWORDS: readonly string[] = Object.freeze([
  '123456789012',
  '1234567890123',
  'password1234',
  'password12345',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopasdf',
  'iloveyou1234',
  'trayvi123456',
  'contraseña123',
  'contrasena1234',
  'republicadominicana',
]);

function key(password: string): string {
  return password.normalize('NFC').toLowerCase();
}

/** Exact match after NFC and lower-casing, so case variants of a listed password are rejected. */
export class ListCompromisedPasswordChecker implements CompromisedPasswordChecker {
  readonly #entries: ReadonlySet<string>;

  constructor(entries: Iterable<string> = SYNTHETIC_COMPROMISED_PASSWORDS) {
    this.#entries = new Set([...entries].map(key).filter((entry) => entry.length > 0));
  }

  static async fromFile(path: string): Promise<ListCompromisedPasswordChecker> {
    const text = await readFile(path, 'utf8');
    return new ListCompromisedPasswordChecker(text.split(/\r?\n/u).map((line) => line.trim()));
  }

  get size(): number {
    return this.#entries.size;
  }

  isCompromised(password: string): Promise<boolean> {
    return Promise.resolve(this.#entries.has(key(password)));
  }
}
