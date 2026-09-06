export type DrainOutcome = 'completed' | 'deadline_exceeded';

export class ActiveOperationRegistry {
  readonly #operations = new Set<symbol>();
  readonly #idleWaiters = new Set<() => void>();

  get size(): number {
    return this.#operations.size;
  }

  track<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const token = Symbol('active-operation');
    this.#operations.add(token);
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#operations.delete(token);
        if (this.#operations.size === 0) {
          for (const resolve of this.#idleWaiters) resolve();
          this.#idleWaiters.clear();
        }
      });
  }

  whenIdle(): Promise<void> {
    if (this.#operations.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }
}

export class IncompleteShutdownError extends Error {
  constructor(readonly activeOperations: number) {
    super(`API shutdown deadline exceeded with ${activeOperations} active operation(s).`);
    this.name = 'IncompleteShutdownError';
  }
}
