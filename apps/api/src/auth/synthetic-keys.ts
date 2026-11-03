import { createHmac } from 'node:crypto';

import { AUTH_KEY_PURPOSES, type VersionedKey } from '@trayvi/auth';

const SYNTHETIC_ROOT = Buffer.from(
  'trayvi.synthetic-auth-keys.v1.development-and-test-only',
  'utf8',
);

/**
 * Deterministic synthetic Auth keys for development and test (AUTH_KEY_SOURCE=synthetic, which
 * configuration rejects in staging and production). Each purpose gets distinct bytes, so the
 * keyring's collision check holds, and contact bindings survive local restarts.
 */
export function syntheticAuthKeys(): readonly VersionedKey[] {
  return AUTH_KEY_PURPOSES.map((purpose) => ({
    purpose,
    version: 'synthetic-v1',
    state: 'PRIMARY' as const,
    material: createHmac('sha256', SYNTHETIC_ROOT).update(purpose, 'utf8').digest(),
  }));
}
