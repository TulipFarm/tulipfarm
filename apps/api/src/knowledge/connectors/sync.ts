import type { PgBoss } from "pg-boss";
import { recordJobRun } from "../../activity/job-run";
import type { ActivityService } from "../../activity/service";
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
  activity?: ActivityService;
}

export interface ConnectorSyncResult {
  connector: string;
  synced: number;
  error?: string;
}

/**
 * Sync one connector: authenticate → listChanged(cursor) → for each changed record fetch + map +
 * write through the existing funnels (the indexer embeds it) → advance the cursor. A failure is
 * recorded on the connector's state row and isolated to that connector (never throws to the caller),
 * so one broken connector can't stall the others. The cursor only advances on success, so a failed
 * run is retried from the same position next time.
 */
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
        // Flat pages upsert by (source, sourceId); a connector setting source != "authored" can
        // never collide with a hand-authored page. OKF pages go through writePage, which owns the
        // (spaceId, path) — an OKF-kind connector is expected to write into a space it owns (no V1
        // connector uses this path; the SampleConnector is flat).
        if (page.kind === "flat") await service.ingestSource(page.input);
        else await service.writePage(page.input);
        synced += 1;
      } catch (recErr) {
        // Per-record isolation: one bad record is recorded and skipped, never stalling the cursor
        // for the whole connector. Connector-level failures (auth/listChanged) are caught below.
        failures.push(`${id}: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
      }
    }
    // Cursor advances even with per-record failures so a permanently-bad record can't wedge the
    // connector; the failures are surfaced on last_error for visibility.
    await state.setCursor(connector.name, changes.cursor);
    if (failures.length > 0) {
      const message = `${failures.length} record(s) failed: ${failures.join("; ")}`;
      await state.recordError(connector.name, message);
      return { connector: connector.name, synced, error: message };
    }
    await state.recordRun(connector.name);
    return { connector: connector.name, synced };
  } catch (err) {
    // Connector-level failure (authenticate / listChanged): cursor is NOT advanced, so the run is
    // retried from the same position next time.
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
        // A connector that actually synced records (or errored) gets its own feed row; silent
        // no-op connectors stay out of the 'connector' category (the job-run row still covers them).
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
