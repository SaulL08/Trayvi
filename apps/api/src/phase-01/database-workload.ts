import type { Pool } from 'pg';

export type DatabaseWorkloadRole = 'trayvi_runtime' | 'trayvi_verification' | 'trayvi_rotation';

const WORKLOAD_AND_PRIVILEGED_ROLES = [
  'trayvi_runtime',
  'trayvi_verification',
  'trayvi_rotation',
  'trayvi_migrator',
  'trayvi_lifecycle_owner',
] as const;

export class DatabaseWorkloadBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseWorkloadBoundaryError';
  }
}

interface WorkloadRow {
  readonly superuser: boolean;
  readonly bypass_rls: boolean;
  readonly holds_expected: boolean;
  readonly other_roles: string[];
}

/**
 * Fails closed unless the pool's login acts as exactly one workload role. A login that also
 * reaches another workload (or the migrator/command owner) would collapse the privilege
 * boundaries that separate enrollment, trusted verification, and key rotation.
 */
export async function assertDatabaseWorkload(
  pool: Pool,
  expected: DatabaseWorkloadRole,
): Promise<void> {
  const others = WORKLOAD_AND_PRIVILEGED_ROLES.filter((role) => role !== expected);
  const result = await pool.query<WorkloadRow>(
    `SELECT role.rolsuper AS superuser,
            role.rolbypassrls AS bypass_rls,
            pg_has_role(current_user, $1::name, 'USAGE') AS holds_expected,
            ARRAY(
              SELECT candidate
              FROM unnest($2::name[]) AS candidate
              WHERE pg_has_role(current_user, candidate, 'MEMBER')
              ORDER BY candidate
            )::text[] AS other_roles
     FROM pg_catalog.pg_roles role
     WHERE role.rolname = current_user`,
    [expected, others],
  );
  const row = result.rows[0];
  if (!row) throw new DatabaseWorkloadBoundaryError('DATABASE_WORKLOAD_UNRESOLVED');
  if (row.superuser || row.bypass_rls) {
    throw new DatabaseWorkloadBoundaryError('DATABASE_WORKLOAD_PRIVILEGED_LOGIN');
  }
  if (!row.holds_expected) {
    throw new DatabaseWorkloadBoundaryError('DATABASE_WORKLOAD_ROLE_MISSING');
  }
  if (row.other_roles.length > 0) {
    throw new DatabaseWorkloadBoundaryError('DATABASE_WORKLOAD_ROLE_OVERLAP');
  }
}
