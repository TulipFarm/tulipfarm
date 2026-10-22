import type { Pool } from 'pg';
import { z } from 'zod';
import type { SlackRuntime } from '@tulipfarm/slack';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export function createSlackInstallationDiscovery(registry: Pick<Pool, 'query'>, runtime: SlackRuntime, appId: string) {
  let after: string | null = null;
  async function installed(workspaceId: string) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx =>
      Boolean(
        (
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_installations')} WHERE app_id=$1 AND state='active'`,
            [appId],
          )
        ).rowCount,
      ),
    );
  }
  return {
    async next() {
      const rows = z
        .array(z.object({ workspace_id: z.uuid() }))
        .parse(
          (
            await registry.query(
              `SELECT workspace_id FROM app.workspace_storage WHERE stage='ready' AND ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT 100`,
              [after],
            )
          ).rows,
        );
      after = rows.length === 100 ? (rows.at(-1)?.workspace_id ?? null) : null;
      return rows.map(row => row.workspace_id);
    },
    installed,
    async requireInstalled(workspaceId: string) {
      if (
        !(
          await registry.query(`SELECT 1 FROM app.workspace_storage WHERE workspace_id=$1 AND stage='ready'`, [
            workspaceId,
          ])
        ).rowCount ||
        !(await installed(workspaceId))
      ) {
        throw new Error('slack-workspace-disabled');
      }
    },
  };
}
