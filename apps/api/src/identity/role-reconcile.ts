import type { EventEmitter } from "node:events";
import {
  type CompiledSoulRole,
  compileSoulRole,
  type Logger,
  type SoulRole,
} from "@tulipfarm/soul";
import type { RoleRepo } from "@tulipfarm/storage";

interface SoulRoles {
  roles: Map<string, SoulRole>;
}
interface ReloadableSoulRoles extends SoulRoles {
  reload(): Promise<void>;
}

/** Bootstrap-owned Role ids must never be deleted or overwritten by Soul-authored Roles. */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set(["owner", "admin", "member"]);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Idempotently project and reap Soul-authored Roles; never reap bootstrap Roles. */
export async function reconcileSoulRoles(
  roles: RoleRepo,
  soul: SoulRoles,
  businessId: string,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  const desiredIds = new Set<string>();
  let projectionComplete = true;
  for (const authored of soul.roles.values()) {
    let compiled: CompiledSoulRole;
    try {
      compiled = compileSoulRole(authored, businessId);
    } catch (err) {
      projectionComplete = false;
      logger?.warn(`[roles] reconcile could not compile soul role "${authored.name}": ${msg(err)}`);
      continue;
    }
    if (RESERVED_ROLE_IDS.has(compiled.id)) {
      logger?.warn(
        `[roles] soul role "${compiled.id}" collides with a reserved bootstrap role — not projected`
      );
      continue;
    }
    try {
      await roles.putRole(compiled);
      desiredIds.add(compiled.id);
    } catch (err) {
      projectionComplete = false;
      logger?.warn(`[roles] reconcile skipped soul role "${compiled.id}": ${msg(err)}`);
    }
  }

  if (!projectionComplete) {
    logger?.warn(
      "[roles] reconcile skipped the reap: a role failed to compile or persist, so the desired " +
        "set is unknown and deleting by absence could destroy a live role and its assignments"
    );
    return;
  }

  const existing = await roles.listRoles(businessId);
  for (const role of existing) {
    if (RESERVED_ROLE_IDS.has(role.id) || desiredIds.has(role.id)) continue;
    try {
      await roles.deleteRole(businessId, role.id);
    } catch (err) {
      logger?.warn(`[roles] reconcile could not reap stale role "${role.id}": ${msg(err)}`);
    }
  }
}

/**
 * On soul.synced, reload from disk and reconcile Roles; failures are logged so sync keeps running.
 */
export function registerSoulRoleReconcile(
  gitSync: EventEmitter,
  soul: ReloadableSoulRoles,
  roles: RoleRepo,
  businessId: string,
  logger: Logger
): void {
  // Serialized, because `soul.reload()` mutates shared loader state that the reconcile then reads.
  // Two overlapping syncs can interleave into a resurrection: the newer one reaps a role that Soul
  // no longer publishes, and the older one — still working from the set it read before the reload —
  // writes that same role straight back. The chain costs nothing (syncs are infrequent) and makes
  // each pass see a settled Soul.
  let queue: Promise<void> = Promise.resolve();
  gitSync.on("soul.synced", () => {
    queue = queue.then(async () => {
      try {
        await soul.reload();
        await reconcileSoulRoles(roles, soul, businessId, logger);
        logger.info("[roles] soul roles reconciled after soul.synced");
      } catch (err) {
        logger.error(`[roles] reconcile after soul.synced failed — ${msg(err)}`);
      }
    });
  });
}
