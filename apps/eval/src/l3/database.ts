/**
 * The L3 tier's database: in-process PostgreSQL, real storage schema.
 *
 * The tier exists to prove what L2 cannot — that a Turn's Run reaches a terminal status, that its
 * budgets are debited, that its Run events are ordered and durable. All three are decided by
 * `@tulipfarm/storage`'s own tables, so the schema comes from that package's DDL exports rather
 * than from a copy: a table shape restated here would drift and the tier would go on passing.
 *
 * The API owns the migration files, and an app may not import another app
 * (`docs/architecture/dependency-rules.md`, rule 1). These DDL exports are the seam the Worker's
 * own process tests already use for exactly that reason.
 */

import { PGlite } from "@electric-sql/pglite";
import {
  FILE_KNOWLEDGE_STATEMENTS,
  FILE_ORIGIN_STATEMENTS,
  FILE_SHARE_STATEMENTS,
  FILE_STORAGE_STATEMENTS,
} from "@tulipfarm/files";
import {
  AUTHORIZATION_STORAGE_STATEMENTS,
  BUDGET_STORAGE_STATEMENTS,
  BudgetStore,
  type Queryable,
  RUN_EVENT_STORAGE_STATEMENTS,
  RUN_STORAGE_STATEMENTS,
  RunEventStore,
  RunStore,
  type TransactionPort,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";

/**
 * The Conversation half of a Turn, which `apps/api` owns and this app may not import.
 *
 * Deliberately the narrowest table that satisfies `TurnCompletionStore`: it holds the identity a
 * Turn is completed by and the assistant Message that completing it appends, and nothing else.
 * Widening it towards the API's real schema would invite a Case to assert on a column the product
 * does not have here, which is a green Case measuring a fiction.
 */
const CONVERSATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS eval_turns (
     business_id      text    NOT NULL,
     run_id           text    NOT NULL,
     turn_id          text    NOT NULL,
     conversation_id  text    NOT NULL,
     attempt          integer NOT NULL,
     status           text,
     cursor           integer,
     message_id       text,
     PRIMARY KEY (business_id, turn_id, attempt)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS eval_turns_run ON eval_turns (business_id, run_id)`,
  `CREATE TABLE IF NOT EXISTS eval_messages (
     id               text PRIMARY KEY,
     business_id      text NOT NULL,
     conversation_id  text NOT NULL,
     turn_id          text NOT NULL,
     attempt          integer NOT NULL,
     role             text NOT NULL,
     content          text NOT NULL,
     tool_calls       jsonb,
     seq              bigserial
   )`,
];

export interface EvalDatabase {
  readonly runs: RunStore;
  readonly events: RunEventStore;
  readonly budgets: BudgetStore;
  readonly transactions: TransactionPort;
  /** Auto-committing handle, for the repositories that take one instead of a transaction. */
  readonly queryable: Queryable;
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as unknown as Queryable)),
  };
}

/**
 * A migrated snapshot, built once and cloned per Trial.
 *
 * Running the DDL costs more than the Turn does, and every Trial needs a database nothing else has
 * written to: a Run left behind by the previous Case would be visible to the next one's reads.
 */
let snapshot: Promise<Blob | File> | undefined;

async function migratedSnapshot(): Promise<Blob | File> {
  snapshot ??= (async () => {
    const database = await PGlite.create();
    for (const statement of [
      ...RUN_STORAGE_STATEMENTS,
      ...WAIT_STORAGE_STATEMENTS,
      ...RUN_EVENT_STORAGE_STATEMENTS,
      ...BUDGET_STORAGE_STATEMENTS,
      ...CONVERSATION_STATEMENTS,
      // A generated File's audience is decided by the Roles its authoring Agent holds, and those
      // are rows: `role_assignments` against a registered Principal. Seeding the answer instead
      // would measure this app's idea of who holds what rather than the product's.
      ...AUTHORIZATION_STORAGE_STATEMENTS,
      // Applied in the order the API's migration ledger applies them: the later three are ALTERs
      // against the first, and `origin` is NOT NULL on every row `create` writes.
      ...FILE_STORAGE_STATEMENTS,
      ...FILE_ORIGIN_STATEMENTS,
      ...FILE_KNOWLEDGE_STATEMENTS,
      ...FILE_SHARE_STATEMENTS,
    ]) {
      await database.exec(statement);
    }
    const dump = await database.dumpDataDir("none");
    await database.close();
    return dump;
  })();
  return await snapshot;
}

/** One isolated database per Trial, so no Trial can observe the one before it. */
export async function openEvalDatabase(): Promise<EvalDatabase> {
  const database = await PGlite.create({ loadDataDir: await migratedSnapshot() });
  const transactions = transactionPort(database);
  return {
    runs: new RunStore(transactions),
    events: new RunEventStore(transactions),
    budgets: new BudgetStore(transactions),
    transactions,
    queryable: database as Queryable,
    query: (text, params) =>
      database.query(text, params as unknown[]) as Promise<{ rows: Record<string, unknown>[] }>,
    close: () => database.close(),
  };
}
