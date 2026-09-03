import type { PGlite } from "@electric-sql/pglite";
import type { Queryable, TransactionPort } from "../ports/transaction";

/**
 * A `TransactionPort` backed by a PGlite instance, for repository tests.
 *
 * Distinct from the production `transactionPort` in `./transaction-helpers`, which takes a
 * `Queryable`: PGlite's own `transaction` handle is structurally compatible but not typed as one.
 */
export function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}
