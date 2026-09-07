import type { EventEmitter } from "node:events";
import { getUniqueKeySpecs } from "@tulipfarm/schema";
import type { Logger, SoulResource } from "@tulipfarm/soul";
import type { Queryable } from "../db";
import { withTransaction } from "../db";
import {
  assertValidType,
  createHistoryTableSql,
  createResourceTableSql,
  dropOwnedUniqueIndexSql,
  isOwnedUniqueIndexName,
  uniqueIndexName,
  uniqueIndexSql,
} from "./schema";

interface ResourceTypes {
  resources: Map<string, SoulResource>;
}
interface ReloadableResourceTypes extends ResourceTypes {
  reload(): Promise<void>;
}

export type ResourceReconcileFailure = {
  type: string;
  message: string;
};

const reconcileQueues = new WeakMap<object, Map<string, Promise<void>>>();
type ResourceSchemaState = {
  readonly fingerprint: string;
  readonly outcome: "pending" | "enforced" | "failed";
};
const resourceSchemaStates = new WeakMap<object, Map<string, ResourceSchemaState>>();

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function schemaFingerprint(resource: SoulResource): string {
  return JSON.stringify(getUniqueKeySpecs(resource.schema));
}

function prepareResourceSchemaStates(soul: ResourceTypes): void {
  const previous = resourceSchemaStates.get(soul);
  const current = new Map<string, ResourceSchemaState>();
  for (const [type, resource] of soul.resources) {
    const fingerprint = schemaFingerprint(resource);
    const prior = previous?.get(type);
    current.set(
      type,
      prior?.fingerprint === fingerprint ? prior : { fingerprint, outcome: "pending" }
    );
  }
  resourceSchemaStates.set(soul, current);
}

function setResourceSchemaState(
  soul: ResourceTypes,
  type: string,
  fingerprint: string,
  outcome: "enforced" | "failed"
): void {
  const states = resourceSchemaStates.get(soul);
  if (states?.get(type)?.fingerprint === fingerprint) {
    states.set(type, { fingerprint, outcome });
  }
}

/** A message means create/update must stop until this exact `x-unique` shape reconciles. */
export function resourceWriteBlock(soul: ResourceTypes, type: string): string | undefined {
  const states = resourceSchemaStates.get(soul);
  if (!states) return undefined;
  const resource = soul.resources.get(type);
  if (!resource) return undefined;
  const state = states.get(type);
  if (!state || state.fingerprint !== schemaFingerprint(resource)) {
    return `resource type ${type} is not ready for writes`;
  }
  if (state.outcome === "enforced") return undefined;
  return state.outcome === "pending"
    ? `resource type ${type} is not ready for writes`
    : `resource type ${type} cannot accept writes because its database constraints are not enforced`;
}

async function serializeForType(q: Queryable, type: string, reconcile: () => Promise<void>) {
  let queues = reconcileQueues.get(q);
  if (!queues) {
    queues = new Map();
    reconcileQueues.set(q, queues);
  }
  const previous = queues.get(type) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(reconcile);
  queues.set(type, current);
  try {
    await current;
  } finally {
    if (queues.get(type) === current) queues.delete(type);
  }
}

async function reconcileUniqueIndexes(
  q: Queryable,
  type: string,
  specs: readonly (readonly string[])[]
): Promise<void> {
  const expected = new Map(specs.map((fields) => [uniqueIndexName(type, fields), fields]));
  const existing = await q.query<{ indexname: string }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'resources'
        AND tablename = $1`,
    [type]
  );
  const existingNames = new Set(
    existing.rows.map((row) => row.indexname).filter((name) => isOwnedUniqueIndexName(type, name))
  );

  for (const name of existingNames) {
    if (!expected.has(name)) await q.query(dropOwnedUniqueIndexSql(type, name));
  }
  for (const [name, fields] of expected) {
    if (!existingNames.has(name)) await q.query(uniqueIndexSql(type, fields));
  }
}

async function reconcileResourceType(
  q: Queryable,
  type: string,
  resource: SoulResource
): Promise<void> {
  await serializeForType(q, type, () =>
    withTransaction(q, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('tulipfarm.resource-reconcile'), hashtext($1))",
        [type]
      );
      await tx.query(createResourceTableSql(type));
      await tx.query(createHistoryTableSql(type));
      await reconcileUniqueIndexes(tx, type, getUniqueKeySpecs(resource.schema));
    })
  );
}

/** Materializes per-type tables and exactly the schema-declared owned uniqueness indexes. */
export async function reconcileResourceTables(
  q: Queryable,
  soul: ResourceTypes,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  prepareResourceSchemaStates(soul);
  for (const [type, resource] of soul.resources) {
    const fingerprint = schemaFingerprint(resource);
    try {
      assertValidType(type);
    } catch (err) {
      setResourceSchemaState(soul, type, fingerprint, "failed");
      logger?.warn(`[resources] reconcile skipped type "${type}": ${msg(err)}`);
      throw err;
    }
    try {
      await reconcileResourceType(q, type, resource);
      setResourceSchemaState(soul, type, fingerprint, "enforced");
    } catch (error) {
      setResourceSchemaState(soul, type, fingerprint, "failed");
      throw error;
    }
  }
}

/**
 * Reconciles every valid type without making one unenforceable schema prevent API recovery.
 * Callers receive every failure and must not report the failed schemas as enforced.
 */
export async function reconcileResourceTablesRecoverably(
  q: Queryable,
  soul: ResourceTypes,
  logger: Pick<Logger, "warn" | "error">
): Promise<ResourceReconcileFailure[]> {
  const failures: ResourceReconcileFailure[] = [];
  prepareResourceSchemaStates(soul);
  for (const [type, resource] of soul.resources) {
    const fingerprint = schemaFingerprint(resource);
    try {
      assertValidType(type);
    } catch (err) {
      const message = msg(err);
      setResourceSchemaState(soul, type, fingerprint, "failed");
      failures.push({ type, message });
      logger.warn(`[resources] reconcile skipped type "${type}": ${message}`);
      continue;
    }
    try {
      await reconcileResourceType(q, type, resource);
      setResourceSchemaState(soul, type, fingerprint, "enforced");
    } catch (err) {
      const message = msg(err);
      setResourceSchemaState(soul, type, fingerprint, "failed");
      failures.push({ type, message });
      logger.error(`[resources] reconcile failed for type "${type}" — ${message}`);
    }
  }
  return failures;
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
        const failures = await reconcileResourceTablesRecoverably(q, soul, logger);
        if (failures.length === 0) {
          logger.info("[resources] per-type tables reconciled after soul.synced");
        } else {
          logger.warn(
            `[resources] reconcile after soul.synced incomplete for: ${failures
              .map(({ type }) => type)
              .join(", ")}`
          );
        }
      } catch (err) {
        logger.error(`[resources] reconcile after soul.synced failed — ${msg(err)}`);
      }
    })();
  });
}
