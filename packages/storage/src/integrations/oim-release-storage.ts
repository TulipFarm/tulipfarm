import { transactionPort } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";
import { OimReleaseDispatchLeaseStore } from "./oim-release-dispatch-store";
import {
  OimReleaseLifecycleStore,
  type OimReleaseSessionSource,
} from "./oim-release-lifecycle-store";
import { OimReleaseOperationStore } from "./oim-release-operation-store";
import { OimReleaseTrustStore } from "./oim-release-trust-store";
import { OimReleaseUninstallJournalStore } from "./oim-release-uninstall-store";

export interface OimReleaseStorageDatabase extends Queryable, OimReleaseSessionSource {}

/** Builds the production release stores around one PostgreSQL pool and one shared lifecycle lock. */
export function createOimReleaseStorage(database: OimReleaseStorageDatabase) {
  const transactions = transactionPort(database);
  const lifecycle = new OimReleaseLifecycleStore(database, transactions);
  return Object.freeze({
    lifecycle,
    operations: new OimReleaseOperationStore(transactions),
    dispatchLeases: new OimReleaseDispatchLeaseStore(transactions),
    trust: new OimReleaseTrustStore(transactions),
    uninstallJournal: new OimReleaseUninstallJournalStore(transactions, lifecycle),
  });
}
