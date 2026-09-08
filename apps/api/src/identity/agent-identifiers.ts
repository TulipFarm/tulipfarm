import { DEFAULT_ASSISTANT_ID, DEFAULT_ASSISTANT_NAME, type Logger } from "@tulipfarm/soul";
import type { Queryable } from "../db";
import type { SoulAgents } from "./agent-principals";

/**
 * A column holding an Agent identifier. Every one of them recorded the Agent's Soul *name*, which
 * the product lets a user change — so a rename silently detached the row from the Agent it names.
 */
interface AgentIdentifierColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Every column that carries an Agent identifier, and nothing else. Each is re-keyed onto the
 * Agent's permanent id by {@link reconcileAgentIdentifiers}.
 *
 * Tables are created lazily by their owning repository rather than all at once, so each is probed
 * before it is written: a deployment that has never used a feature has no table for it.
 *
 * `audit_events.agent_id` is deliberately absent: that table is append-only and hash-chained, and
 * the database grant refuses any `UPDATE` on it, in-place rekey or otherwise. A row written before
 * an Agent's id cutover keeps recording whatever identifier was true at the time, which is what an
 * immutable audit trail is for; it is never rewritten to match a later rename.
 */
const AGENT_IDENTIFIER_COLUMNS: readonly AgentIdentifierColumn[] = [
  { table: "conversations", column: "agent_id" },
  { table: "channel_delivery_attempts", column: "agent_id" },
  { table: "channel_run_deliveries", column: "agent_id" },
  { table: "integration_routes", column: "agent_id" },
  { table: "obs_event", column: "agent_id" },
  { table: "tasks", column: "origin_agent_id" },
  { table: "file_generation_drafts", column: "authored_by_agent_id" },
  { table: "asset_ownership_approvals", column: "agent_principal_id" },
];

/**
 * The children of `asset_ownership`, which reference it by `(business_id, asset_type, asset_id)`
 * with no `ON UPDATE CASCADE`. They must move to the new id after the parent row exists under it
 * and before the old parent row goes, or the foreign key refuses the move.
 */
const AGENT_ASSET_CHILD_TABLES: readonly string[] = [
  "asset_owners",
  "asset_team_shares",
  "asset_ownership_operations",
];

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function hasColumn(q: Queryable, table: string, column: string): Promise<boolean> {
  const present = await q.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return present.rows.length > 0;
}

/**
 * The rename each Agent needs: its old name-shaped identifier, and the permanent id replacing it.
 *
 * The default assistant is included because chat runs on it and it is not a Soul artifact, so no
 * publication would ever rename its rows. An Agent whose stored identifier already equals its id
 * yields nothing — that is what makes a second pass a no-op.
 */
function renames(soul: SoulAgents): ReadonlyMap<string, string> {
  const out = new Map<string, string>([[DEFAULT_ASSISTANT_NAME, DEFAULT_ASSISTANT_ID]]);
  for (const agent of soul.agents.values()) {
    if (agent.name !== agent.id) out.set(agent.name, agent.id);
  }
  out.delete(DEFAULT_ASSISTANT_ID);
  return out;
}

/**
 * Re-key one Agent's Team-ownership rows, parent before children before the old parent.
 *
 * A straight `UPDATE` of `asset_ownership.asset_id` cannot work: its children hold the old value
 * and their foreign key has no `ON UPDATE CASCADE`, so the update is refused. Copying the parent
 * first gives the children somewhere to point, and the old parent is only removed once nothing
 * references it. `ON CONFLICT DO NOTHING` makes a second pass — or a half-finished first one —
 * settle on the rows already there.
 */
async function moveAssetOwnership(
  q: Queryable,
  businessId: string,
  name: string,
  id: string
): Promise<void> {
  const stale = await q.query(
    `SELECT 1 FROM asset_ownership
      WHERE business_id = $1 AND asset_type = 'agent' AND asset_id = $2`,
    [businessId, name]
  );
  if (stale.rows.length === 0) return;

  await q.query(
    `INSERT INTO asset_ownership (business_id, asset_type, asset_id, revision, created_at)
     SELECT business_id, asset_type, $3, revision, created_at
       FROM asset_ownership
      WHERE business_id = $1 AND asset_type = 'agent' AND asset_id = $2
     ON CONFLICT DO NOTHING`,
    [businessId, name, id]
  );

  for (const table of AGENT_ASSET_CHILD_TABLES) {
    if (!(await hasColumn(q, table, "asset_id"))) continue;
    await q.query(
      `UPDATE ${table} SET asset_id = $1
        WHERE business_id = $2 AND asset_type = 'agent' AND asset_id = $3`,
      [id, businessId, name]
    );
  }
  await q.query(
    `DELETE FROM asset_ownership
      WHERE business_id = $1 AND asset_type = 'agent' AND asset_id = $2`,
    [businessId, name]
  );
}

/**
 * Move every stored Agent identifier from the Agent's name onto its permanent id.
 *
 * This is the cut-over half of keying Agents on an id: the writers already record whatever the
 * request carried, and the request now carries an id, so only rows written before that switch
 * still name an Agent by name. Running it at boot rather than as a schema migration is deliberate
 * — the mapping is `name -> agent.id`, which only the loaded Soul can supply.
 *
 * Idempotent and per-table isolated: a table that does not exist is skipped, and a table that
 * fails is logged rather than thrown, so one unmigratable feature cannot stop the deployment from
 * booting with the rest re-keyed. A per-table failure is logged at `error`, not `warn` — the
 * durable app log only retains `error`/`fatal` records (`@tulipfarm/observability`), and a rejected
 * rekey is exactly the kind of partial state an operator needs to be able to find later, not a
 * transient notice that is fine to lose.
 */
export async function reconcileAgentIdentifiers(
  q: Queryable,
  soul: SoulAgents,
  businessId: string,
  logger?: Pick<Logger, "error">
): Promise<void> {
  const mapping = renames(soul);
  if (mapping.size === 0) return;

  // Not scoped by business: several of these tables carry no `business_id`, and a deployment holds
  // exactly one business (`DEPLOYMENT_BUSINESS_ID`), so the identifier alone selects its rows.

  for (const { table, column } of AGENT_IDENTIFIER_COLUMNS) {
    if (!(await hasColumn(q, table, column))) continue;
    for (const [name, id] of mapping) {
      try {
        await q.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [id, name]);
      } catch (err) {
        logger?.error(`[agents] could not re-key ${table}.${column} for "${name}": ${msg(err)}`);
      }
    }
  }

  if (await hasColumn(q, "asset_ownership", "asset_id")) {
    for (const [name, id] of mapping) {
      try {
        await moveAssetOwnership(q, businessId, name, id);
      } catch (err) {
        logger?.error(`[agents] could not re-key ownership of agent "${name}": ${msg(err)}`);
      }
    }
  }

  // Last, because everything above still had to find its rows under the old identifier. Deleting
  // the name-keyed Principal cascades its Role assignment away with it.
  for (const [name] of mapping) {
    try {
      await q.query(
        `DELETE FROM principals WHERE business_id = $1 AND id = $2 AND kind = 'agent'`,
        [businessId, name]
      );
    } catch (err) {
      logger?.error(`[agents] could not reap the name-keyed principal "${name}": ${msg(err)}`);
    }
  }
}
