import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '@trayvi/config';

import { createWorkerApplication } from '../src/bootstrap';

describe('worker process foundation', () => {
  it('starts and closes idempotently without fake outbox processing', async () => {
    const config = parseAppConfig(
      {
        NODE_ENV: 'test',
        SERVICE_NAME: 'worker',
        SERVICE_VERSION: 'integration',
        DATABASE_URL: 'postgresql://unused:local-only-value@127.0.0.1:1/unused',
      },
      'worker',
    );
    const runtime = await createWorkerApplication(config);

    expect(runtime.metrics.snapshot().workerLifecycle).toEqual({ 'event=started': 1 });
    await Promise.all([runtime.close('SIGTERM'), runtime.close('SIGINT')]);
    expect(runtime.metrics.snapshot().workerLifecycle).toEqual({
      'event=started': 1,
      'event=draining': 1,
      'event=stopped': 1,
    });
  });
});
