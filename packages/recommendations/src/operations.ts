import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange, recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';

export const recommendationCursorSchema = z.object({ workspaceId: z.uuid(), membershipId: z.uuid().nullable() });
const inputSchema = z
  .strictObject({
    operationId: z.uuid(),
    mode: z.enum(['backfill', 'repair']),
    apply: z.boolean(),
    workspaceId: z.uuid().optional(),
    membershipId: z.uuid().optional(),
    after: recommendationCursorSchema.nullable().default(null),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .refine(input => !input.membershipId || !!input.workspaceId, 'A membership needs its workspace');
export type RecommendationOperation = z.input<typeof inputSchema>;

export function createRecommendationOperations(options: {
  pool: Pick<Pool, 'query'>;
  runtime: Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
  eligible(workspaceId: string, userId: string): Promise<boolean>;
}) {
  return {
    async page(input: RecommendationOperation) {
      const request = inputSchema.parse(input);
      const workspace = z
        .object({ workspace_id: z.uuid() })
        .optional()
        .parse(
          (
            await options.pool.query(
              `SELECT workspace_id FROM app.workspace_storage WHERE stage='ready'
         AND ($1::uuid IS NULL OR workspace_id=$1)
         AND ($2::uuid IS NULL OR workspace_id>$2 OR (workspace_id=$2 AND $3::uuid IS NOT NULL))
         ORDER BY workspace_id LIMIT 1`,
              [request.workspaceId ?? null, request.after?.workspaceId ?? null, request.after?.membershipId ?? null],
            )
          ).rows[0],
        );
      if (!workspace) return { scanned: 0, eligible: 0, queued: 0, next: null };
      const workspaceId = workspace.workspace_id;
      const members = await options.runtime.transaction(workspaceId, recommendationCompatibility, async tx => {
        await lockAuthorization(tx);
        return z.array(z.object({ id: z.uuid(), user_id: z.string() })).parse(
          (
            await tx.client.query(
              `SELECT id,user_id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE removed_at IS NULL
           AND ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR id=$2) ORDER BY id LIMIT $3`,
              [
                request.after?.workspaceId === workspaceId ? request.after.membershipId : null,
                request.membershipId ?? null,
                request.limit,
              ],
            )
          ).rows,
        );
      });
      let eligible = 0,
        queued = 0;
      for (const member of members) {
        if (!(await options.eligible(workspaceId, member.user_id))) continue;
        eligible++;
        if (!request.apply) continue;
        const hash = createHash('sha256')
          .update(`recommendations:${request.operationId}:${workspaceId}:${member.id}`)
          .digest('hex');
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const recorded = await options.runtime.transaction(workspaceId, recommendationCompatibility, async tx => {
          await lockAuthorization(tx);
          if (
            !(
              await tx.client.query(
                `SELECT 1 FROM ${qualified(tx.schema, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
                [member.id],
              )
            ).rowCount
          )
            return false;
          return (
            await recordRecommendationChange(tx, {
              id,
              kind: request.mode === 'backfill' ? 'seed' : 'repair',
              sourceId: `${request.mode}:${request.operationId}`,
              membershipIds: [member.id],
            })
          ).recorded;
        });
        if (recorded) queued++;
      }
      return {
        scanned: members.length,
        eligible,
        queued,
        next: { workspaceId, membershipId: members.length === request.limit ? members.at(-1)!.id : null },
      };
    },
  };
}
