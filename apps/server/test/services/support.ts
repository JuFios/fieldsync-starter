import type { SqlResult } from '../../src/db';

/** A `Db` double: `query` and `tx` are Jest mocks; `tx` runs its callback with `inTx` as the handle. */
export function mockDb() {
  const inTx = {
    query: jest.fn<Promise<SqlResult<unknown>>, [string, unknown[]?]>(),
    /** Runs the callback directly, like a savepoint that is released or rolled back around it. */
    savepoint: jest.fn(<T>(fn: () => Promise<T>) => fn()),
  };
  return {
    query: jest.fn<Promise<SqlResult<unknown>>, [string, unknown[]?]>(),
    tx: jest.fn(<T>(fn: (sql: typeof inTx) => Promise<T>) => fn(inTx)),
    inTx,
  };
}

export type MockDb = ReturnType<typeof mockDb>;

export function result<T>(rows: T[], rowCount = rows.length): SqlResult<T> {
  return { rows, rowCount };
}

/** A ConfigService double that serves the given settings. */
export function mockConfig(values: Record<string, unknown>) {
  return { get: jest.fn((key: string) => values[key]) };
}
