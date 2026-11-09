import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { RandomSource } from '../../contracts/runtime';
import type { ScryptParameters } from '../../domain/password/password-policy';

export interface PasswordHash {
  readonly parameterVersion: string;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

export class PasswordHasherError extends Error {
  constructor(code: 'PASSWORD_PARAMETERS_INVALID' | 'PASSWORD_ENTROPY_UNAVAILABLE') {
    super(code);
    this.name = 'PasswordHasherError';
  }
}

/** Caps concurrent scrypt calls so verification cannot exhaust memory or the libuv pool. */
export class Semaphore {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#available = size;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#available > 0) {
      this.#available -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#available += 1;
    }
  }
}

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFC'),
      salt,
      parameters.keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        // scrypt needs 128 * N * r bytes; allow twice that.
        maxmem: 256 * parameters.cost * parameters.blockSize,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * Versioned scrypt (PLAN §10) through Node's asynchronous API, so hashing never blocks the event
 * loop. Unknown parameter versions verify as a mismatch rather than throwing.
 */
export class ScryptPasswordHasher {
  readonly #versions: Readonly<Record<string, ScryptParameters>>;
  readonly #current: string;
  readonly #semaphore: Semaphore;
  readonly #random: RandomSource;

  constructor(options: {
    readonly versions: Readonly<Record<string, ScryptParameters>>;
    readonly current: string;
    readonly concurrency: number;
    readonly random?: RandomSource;
  }) {
    if (
      !options.versions[options.current] ||
      !Number.isInteger(options.concurrency) ||
      options.concurrency < 1
    ) {
      throw new PasswordHasherError('PASSWORD_PARAMETERS_INVALID');
    }
    this.#versions = options.versions;
    this.#current = options.current;
    this.#semaphore = new Semaphore(options.concurrency);
    this.#random = options.random ?? { bytes: (length) => randomBytes(length) };
  }

  get currentVersion(): string {
    return this.#current;
  }

  needsRehash(parameterVersion: string): boolean {
    return parameterVersion !== this.#current;
  }

  async hash(password: string): Promise<PasswordHash> {
    const parameters = this.#versions[this.#current];
    if (!parameters) throw new PasswordHasherError('PASSWORD_PARAMETERS_INVALID');
    const salt = this.#random.bytes(parameters.saltLength);
    if (salt.byteLength !== parameters.saltLength) {
      throw new PasswordHasherError('PASSWORD_ENTROPY_UNAVAILABLE');
    }
    const hash = await this.#semaphore.run(() => derive(password, salt, parameters));
    return { parameterVersion: this.#current, salt, hash };
  }

  async verify(password: string, stored: PasswordHash): Promise<boolean> {
    const parameters = this.#versions[stored.parameterVersion];
    if (!parameters || stored.hash.byteLength !== parameters.keyLength) return false;
    const candidate = await this.#semaphore.run(() => derive(password, stored.salt, parameters));
    return timingSafeEqual(candidate, stored.hash);
  }
}
