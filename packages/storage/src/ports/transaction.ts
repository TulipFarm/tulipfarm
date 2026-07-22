/**
 * Provider-neutral PostgreSQL transaction port.
 *
 * Capability id `postgres` (required; the sole correctness-critical capability —
 * see `@tulipfarm/observability` capability catalog). The shape is the minimal
 * query surface shared by the production `pg.Pool` and the test client, so repos
 * and migrations run identical SQL in both. Domain packages receive a
 * transaction-scoped `Queryable` and never import `pg` or hold a raw pool.
 */

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
