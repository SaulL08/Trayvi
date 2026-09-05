export type RuntimeLifecycle =
  'CREATED' | 'INITIALIZING' | 'READY' | 'DRAINING' | 'STOPPED' | 'FAILED';

export class RuntimeState {
  #state: RuntimeLifecycle = 'CREATED';

  get lifecycle(): RuntimeLifecycle {
    return this.#state;
  }

  beginInitialization(): void {
    if (this.#state !== 'CREATED') throw new Error('Runtime initialization may only begin once.');
    this.#state = 'INITIALIZING';
  }

  markReady(): void {
    if (this.#state !== 'INITIALIZING') throw new Error('Runtime is not initializing.');
    this.#state = 'READY';
  }

  beginDraining(): void {
    if (this.#state === 'READY' || this.#state === 'INITIALIZING') this.#state = 'DRAINING';
  }

  markStopped(): void {
    if (this.#state !== 'FAILED') this.#state = 'STOPPED';
  }

  markFailed(): void {
    this.#state = 'FAILED';
  }

  acceptsTraffic(): boolean {
    return this.#state === 'READY';
  }
}
