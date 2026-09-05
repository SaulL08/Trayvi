import type { Logger } from './logger';

export type ShutdownTask = () => void | Promise<void>;

export class ShutdownCoordinator {
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #tasks: (readonly [string, ShutdownTask])[] = [];
  #shutdownPromise: Promise<void> | undefined;

  constructor(logger: Logger, timeoutMs: number) {
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
  }

  register(name: string, task: ShutdownTask): void {
    this.#tasks.push([name, task]);
  }

  shutdown(signal: string): Promise<void> {
    this.#shutdownPromise ??= this.#run(signal);
    return this.#shutdownPromise;
  }

  async #run(signal: string): Promise<void> {
    this.#logger.info('runtime.draining', { signal, outcome: 'started' });
    const completion = (async () => {
      for (const [name, task] of [...this.#tasks].reverse()) {
        try {
          await task();
        } catch (error: unknown) {
          this.#logger.error('runtime.shutdown.task_failed', error, { task: name });
        }
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#timeoutMs);
      timer.unref();
    });
    const outcome = await Promise.race([completion.then(() => 'completed' as const), timeout]);
    if (timer) clearTimeout(timer);
    this.#logger.info('runtime.stopped', { outcome });
    this.#logger.flush();
  }
}
