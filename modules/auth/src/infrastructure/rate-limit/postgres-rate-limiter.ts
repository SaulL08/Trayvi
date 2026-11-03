import type {
  RateLimitDecision,
  RateLimitDimension,
  RateLimiter,
} from '../../contracts/rate-limit';
import type { SqlExecutor } from '../../contracts/runtime';
import {
  admitted,
  denied,
  peekDecision,
  RATE_LIMIT_DIMENSIONS,
  RATE_LIMIT_WINDOWS,
  windowFor,
  type RateLimitPolicy,
} from '../../domain/rate-limit/rate-limit-policy';

const SUBJECT_BYTES = 32;

function assertSubject(subject: Buffer): void {
  if (!Buffer.isBuffer(subject) || subject.byteLength !== SUBJECT_BYTES) {
    throw new TypeError('RATE_LIMIT_SUBJECT_INVALID');
  }
}

/**
 * PLAN §11 limiter over auth.rate_limit_buckets (migration 0015). It runs on its own autocommit
 * executor, never the caller's transaction, so a consumed unit survives a caller rollback.
 */
export class PostgresRateLimiter implements RateLimiter {
  readonly #sql: SqlExecutor;
  readonly #policy: RateLimitPolicy;

  constructor(sql: SqlExecutor, policy: RateLimitPolicy) {
    this.#sql = sql;
    this.#policy = policy;
  }

  async consume(
    dimension: RateLimitDimension,
    subject: Buffer,
    at: Date,
  ): Promise<RateLimitDecision> {
    assertSubject(subject);
    const rule = this.#policy.rule(dimension);
    const window = windowFor(rule, at);
    // One statement: read the previous window and admit one unit in the current window only if the
    // two together stay within the limit. Concurrent callers serialize on the bucket row.
    const result = await this.#sql.query<{
      previous: number;
      bumped: number | null;
      current: number | null;
    }>(
      `WITH previous AS (
         SELECT coalesce(max(count), 0) AS units
         FROM auth.rate_limit_buckets
         WHERE dimension = $1 AND subject = $2 AND window_start = $4
       ), bumped AS (
         INSERT INTO auth.rate_limit_buckets AS bucket (dimension, subject, window_start, count)
         SELECT $1, $2, $3, 1 FROM previous WHERE previous.units + 1 <= $5
         ON CONFLICT (dimension, subject, window_start)
         DO UPDATE SET count = bucket.count + 1
         WHERE bucket.count + (SELECT units FROM previous) + 1 <= $5
         RETURNING bucket.count
       )
       SELECT (SELECT units FROM previous) AS previous,
              (SELECT count FROM bumped) AS bumped,
              (SELECT count FROM auth.rate_limit_buckets
               WHERE dimension = $1 AND subject = $2 AND window_start = $3) AS current`,
      [dimension, subject, window.start, window.previousStart, rule.limit],
    );
    const row = result.rows[0];
    const previous = row?.previous ?? 0;
    if (row?.bumped !== null && row?.bumped !== undefined)
      return admitted(rule, previous + row.bumped);
    return denied(rule, window, row?.current ?? 0, at);
  }

  async peek(dimension: RateLimitDimension, subject: Buffer, at: Date): Promise<RateLimitDecision> {
    assertSubject(subject);
    const rule = this.#policy.rule(dimension);
    const window = windowFor(rule, at);
    const result = await this.#sql.query<{ previous: number; current: number }>(
      `SELECT coalesce(max(count) FILTER (WHERE window_start = $4), 0) AS previous,
              coalesce(max(count) FILTER (WHERE window_start = $3), 0) AS current
       FROM auth.rate_limit_buckets
       WHERE dimension = $1 AND subject = $2 AND window_start IN ($3, $4)`,
      [dimension, subject, window.start, window.previousStart],
    );
    const row = result.rows[0];
    return peekDecision(
      rule,
      window,
      { previous: row?.previous ?? 0, current: row?.current ?? 0 },
      at,
    );
  }

  /** Deletes buckets that no longer count toward any decision (older than two windows). */
  async prune(at: Date): Promise<number> {
    const result = await this.#sql.query(
      `DELETE FROM auth.rate_limit_buckets bucket
       USING unnest($1::varchar[], $2::integer[]) AS rule (dimension, window_seconds)
       WHERE bucket.dimension = rule.dimension
         AND bucket.window_start < $3::timestamptz - make_interval(secs => rule.window_seconds * 2)`,
      [
        RATE_LIMIT_DIMENSIONS,
        RATE_LIMIT_DIMENSIONS.map((dimension) => RATE_LIMIT_WINDOWS[dimension]),
        at,
      ],
    );
    return result.rowCount;
  }
}
