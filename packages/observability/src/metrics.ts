export interface MetricsSnapshot {
  readonly httpRequests: Readonly<Record<string, number>>;
  readonly httpDurationMilliseconds: Readonly<Record<string, number>>;
  readonly databaseProbes: Readonly<Record<string, number>>;
  readonly workerLifecycle: Readonly<Record<string, number>>;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export class FoundationMetrics {
  readonly #enabled: boolean;
  readonly #httpRequests = new Map<string, number>();
  readonly #httpDurationMilliseconds = new Map<string, number>();
  readonly #databaseProbes = new Map<string, number>();
  readonly #workerLifecycle = new Map<string, number>();

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  recordHttp(method: string, statusCode: number, durationMilliseconds: number): void {
    if (!this.#enabled) return;
    const safeMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)
      ? method
      : 'OTHER';
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `method=${safeMethod},status_class=${statusClass}`;
    increment(this.#httpRequests, key);
    increment(this.#httpDurationMilliseconds, key, Math.max(0, durationMilliseconds));
  }

  recordDatabaseProbe(outcome: 'up' | 'down' | 'timeout', durationMilliseconds: number): void {
    if (!this.#enabled) return;
    increment(this.#databaseProbes, `outcome=${outcome}`);
    increment(this.#databaseProbes, `duration_ms_total`, Math.max(0, durationMilliseconds));
  }

  recordWorkerLifecycle(event: 'started' | 'draining' | 'stopped' | 'failed'): void {
    if (!this.#enabled) return;
    increment(this.#workerLifecycle, `event=${event}`);
  }

  snapshot(): MetricsSnapshot {
    return {
      httpRequests: Object.fromEntries(this.#httpRequests),
      httpDurationMilliseconds: Object.fromEntries(this.#httpDurationMilliseconds),
      databaseProbes: Object.fromEntries(this.#databaseProbes),
      workerLifecycle: Object.fromEntries(this.#workerLifecycle),
    };
  }
}
