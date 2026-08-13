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

/**
 * Role ids the bootstrap layer owns: migration 50 seeds `owner`, and `syncDeploymentRoles` seeds
 * `admin`/`member` on every boot. The Soul reconciler must never delete or overwrite these — an
 * authored Role that collides with one of them is skipped rather than silently replacing the
 * deployment's own authority, which could lock the owner out.
 *
 * Exported so the admin authorization surface can distinguish these built-in Roles from
 * Soul-authored ones without maintaining a second copy of the list that could drift.
 */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set(["owner", "admin", "member"]);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Projects authored Soul Roles into the durable role rows the `LiveAuthorityLayerResolver` reads,
 * mirroring the `reconcileResourceTables` pattern: it runs on boot and again after every soul sync,
 * and is idempotent — re-running with the same Soul state is a no-op because `putRole` upserts.
 *
 * Unlike the resource reconciler it must also *reap*: a Role removed from Soul has to disappear
 * from the durable rows, or under Stage 4's default-deny it would keep granting after its author
 * deleted it. Reaping is bounded to non-reserved roles so it can never delete a bootstrap role.
 * Every durable non-reserved Role is authored in Soul today (Soul is the only writer of them), so
 * "delete non-reserved roles absent from Soul" reaps exactly the stale authored Roles.
 *
 * **Compilation is per role, and the reap only runs when the desired set is known-complete.**
 * Both halves of that sentence are load-bearing, and each replaces a real defect:
 *
 * - Compiling the whole catalog up front meant one schema-valid-but-uncompilable artifact threw
 *   before anything was written. On boot that exits the process; on a running instance the handler
 *   swallows it, so *nothing* is projected and *nothing* is reaped on every subsequent sync —
 *   revocation-by-Soul-deletion silently stops working, which is the exact failure the reap exists
 *   to prevent. Per-role compilation contains the blast radius to the bad artifact.
 *
 * - Skipping a failed role and then reaping is worse than not reaping: `deleteRole` cascades to
 *   `role_assignments` and `group_role_assignments`, so one transient database blip during a
 *   routine sync would delete a live Role *and every assignment of it*. Re-authoring the Role in
 *   Soul restores the definition but not who held it, and nothing records who did. A failure means
 *   the desired set is *unknown*, not *empty* — so the reap is skipped for that pass. A stale Role
 *   surviving one extra cycle is recoverable; a destroyed grant graph is not.
 */
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
 * Reconcile authored Soul Roles into durable rows on every `soul.synced`, mirroring
 * `registerResourceReconcile`: reload the Soul catalog from disk, then project + reap Roles. A
 * failure is logged, never thrown, so the sync loop stays up.
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
