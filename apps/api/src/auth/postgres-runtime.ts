import type { Pool, PoolClient } from 'pg';

import type { SqlExecutor, TransactionRunner } from '@trayvi/auth';

function executorOver(client: Pool | PoolClient): SqlExecutor {
  return {
    query: async <Row extends object>(text: string, values: readonly unknown[]) => {
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

/** Autocommit executor: each statement commits on its own (rate-limit buckets). */
export function poolExecutor(pool: Pool): SqlExecutor {
  return executorOver(pool);
}

/** Runs work in one READ COMMITTED transaction on a dedicated pooled connection. */
export function poolTransactions(pool: Pool): TransactionRunner {
  return {
    async inTransaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await work(executorOver(client));
        await client.query('COMMIT');
        return value;
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
