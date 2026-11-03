export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuidV7(): string;
}

export interface RandomSource {
  bytes(length: number): Buffer;
}

export interface SqlExecutor {
  query<Row extends object>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number }>;
}

export interface TransactionRunner {
  inTransaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}
