import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { humanTableGrantPredicate, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange, recommendationsInstalled } from '@tulipfarm/workspace-storage/recommendations';

export async function recordTableRecommendationChange(
  tx: AuthorizationTransaction,
  tableId: string,
  kind: 'definition' | 'rows',
  invalidate = false,
) {
  const transaction = { client: tx.client, schema: tx.schema };
  if (!(await recommendationsInstalled(transaction))) return;
  const predicate = await humanTableGrantPredicate(tx, {
    membershipId: 'm.id',
    assetId: '$1',
    permissions: "ARRAY['table.row.read']::text[]",
  });
  const members = z
    .array(z.object({ id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT m.id FROM ${qualified(tx.schema, 'tf_memberships')} m WHERE m.removed_at IS NULL AND (m.role='admin' OR ${predicate}) ORDER BY m.id`,
          [tableId],
        )
      ).rows,
    );
  await recordRecommendationChange(transaction, {
    id: randomUUID(),
    kind,
    sourceId: tableId,
    membershipIds: members.map(member => member.id),
    invalidate,
  });
}
