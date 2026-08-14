import type { EventEmitter } from "node:events";
import type { Logger } from "@tulipfarm/soul";
import type { Queryable } from "../db";
import { createHistoryTableSql, createResourceTableSql } from "./schema";

interface ResourceTypes {
  resources: Map<string, unknown>;
}
interface ReloadableResourceTypes extends ResourceTypes {
  reload(): Promise<void>;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Idempotently materializes per-type tables; a bad type is logged and skipped. */
export async function reconcileResourceTables(
  q: Queryable,
  soul: ResourceTypes,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  for (const type of soul.resources.keys()) {
    try {
      await q.query(createResourceTableSql(type));
      await q.query(createHistoryTableSql(type));
    } catch (err) {
      logger?.warn(`[resources] reconcile skipped type "${type}": ${msg(err)}`);
    }
  }
}

/** On `soul.synced`, reloads Soul and materializes any newly introduced type tables. */
export function registerResourceReconcile(
  gitSync: EventEmitter,
  soul: ReloadableResourceTypes,
  q: Queryable,
  logger: Logger
): void {
  gitSync.on("soul.synced", () => {
    void (async () => {
      try {
        await soul.reload();
        await reconcileResourceTables(q, soul, logger);
        logger.info("[resources] per-type tables reconciled after soul.synced");
      } catch (err) {
        logger.error(`[resources] reconcile after soul.synced failed — ${msg(err)}`);
      }
    })();
  });
}
