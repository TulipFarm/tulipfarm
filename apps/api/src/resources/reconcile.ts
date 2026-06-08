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

/**
 * Idempotently create the per-type table (+ its history table) for every loaded
 * resource type. Postgres can't lazily materialise a table the way `db.collection(type)`
 * did, so this runs on boot, after `POST /resource-types`, and after each soul sync.
 * A single bad type is logged and skipped rather than failing the whole pass.
 */
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

/**
 * Reconcile per-type tables on every `soul.synced` (mirrors `registerLlmReload`):
 * reload the soul from disk, then create any tables a freshly-pulled type introduced.
 * Its own reload is independent of the llm reloader — both are cheap idempotent dir
 * scans at the 5-minute sync cadence.
 */
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
