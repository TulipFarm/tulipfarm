import { type ActivityRecorderPort, recordJobRun } from "@tulipfarm/observability";
import type { PgBoss } from "pg-boss";
import type { KnowledgeService } from "../service";
import type { ConnectorStateRepo } from "./state-repo";
import type { Connector, ConnectorRegistry } from "./types";

export const CONNECTOR_SYNC_QUEUE = "connector-sync";
/** Every 15 minutes — connectors are incremental, so a modest cadence is plenty. */
export const CONNECTOR_SYNC_CRON = "*/15 * * * *";

export interface ConnectorSyncDeps {
  registry: ConnectorRegistry;
  state: ConnectorStateRepo;
  service: KnowledgeService;
  /** Optional: record the job run + per-connector sync results in the activity feed. */
  activity?: ActivityRecorderPort;
}

export interface ConnectorSyncResult {
  connector: string;
  synced: number;
  error?: string;
}

/** Sync one connector; record failures, never throw, and advance the cursor only on success. */
export async function syncConnector(
  connector: Connector,
  deps: ConnectorSyncDeps
): Promise<ConnectorSyncResult> {
  const { state, service } = deps;
  await state.ensure(connector.name);
  const existing = await state.get(connector.name);
  const cursor = existing?.cursor ?? null;
  try {
    await connector.authenticate();
    const changes = await connector.listChanged(cursor);
    let synced = 0;
    const failures: string[] = [];
    for (const id of changes.ids) {
      try {
        const record = await connector.fetch(id);
        const page = connector.mapToPage(record);
        // Flat pages upsert by (source, sourceId), so non-authored connectors cannot collide.
        if (page.kind === "flat") await service.ingestSource(page.input);
        else await service.writePage(page.input);
        synced += 1;
      } catch (recErr) {
        // Per-record failures are recorded and skipped; connector-level failures are caught below.
        failures.push(`${id}: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
      }
    }
    // Advance despite per-record failures so one bad record cannot wedge the connector.
    await state.setCursor(connector.name, changes.cursor);
    if (failures.length > 0) {
      const message = `${failures.length} record(s) failed: ${failures.join("; ")}`;
      await state.recordError(connector.name, message);
      return { connector: connector.name, synced, error: message };
    }
    await state.recordRun(connector.name);
    return { connector: connector.name, synced };
  } catch (err) {
    // Connector-level failures do not advance the cursor; retry from the same position.
    const message = err instanceof Error ? err.message : String(err);
    await state.recordError(connector.name, message);
    return { connector: connector.name, synced: 0, error: message };
  }
}

/** Sync every connector that is both registered and flagged enabled. */
export async function runConnectorSync(deps: ConnectorSyncDeps): Promise<ConnectorSyncResult[]> {
  const enabled = await deps.state.listEnabled();
  const results: ConnectorSyncResult[] = [];
  for (const s of enabled) {
    const connector = deps.registry.get(s.name);
    if (!connector) continue; // enabled in DB but not registered in this build — skip safely
    results.push(await syncConnector(connector, deps));
  }
  return results;
}

/** Register the scheduled connector-sync job (mirrors soul-sync / stream-gc). */
export async function registerConnectorSync(boss: PgBoss, deps: ConnectorSyncDeps): Promise<void> {
  await boss.createQueue(CONNECTOR_SYNC_QUEUE);
  await boss.work(CONNECTOR_SYNC_QUEUE, () =>
    recordJobRun(
      deps.activity,
      CONNECTOR_SYNC_QUEUE,
      async () => {
        const results = await runConnectorSync(deps);
        // Only connectors that synced or errored get feed rows; silent no-ops stay out.
        for (const r of results) {
          if (r.synced > 0 || r.error) {
            await deps.activity?.record({
              category: "connector",
              action: "connector.synced",
              targetType: "connector",
              targetId: r.connector,
              status: r.error ? "error" : "ok",
              summary: r.error
                ? `Connector ${r.connector} sync failed`
                : `Connector ${r.connector} synced ${r.synced} record(s)`,
              metadata: { synced: r.synced, ...(r.error ? { error: r.error } : {}) },
            });
          }
        }
        return results;
      },
      (results) => ({
        summary: `Connector sync ran (${results.reduce((n, r) => n + r.synced, 0)} synced)`,
        metadata: { connectors: results.length },
      })
    )
  );
  await boss.schedule(CONNECTOR_SYNC_QUEUE, CONNECTOR_SYNC_CRON);
}
