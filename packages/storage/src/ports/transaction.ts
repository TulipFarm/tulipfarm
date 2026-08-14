/** Transaction-scoped PostgreSQL port; `postgres` is the sole correctness-critical capability. */

export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface TransactionPort {
  /** Run `fn` inside one transaction: commit when it resolves, roll back if it throws. */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
