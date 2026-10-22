import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  requireTablePermission,
  type HumanActor,
} from '@tulipfarm/access';
import { tableProposalDigest } from '@tulipfarm/tables/proposals';
import { executionCompatibility } from '@tulipfarm/tables/execution';
import { createTableService, mutationSchema } from '@tulipfarm/tables/service';
import { valuesSchema } from '@tulipfarm/tables/definition';
import { TableError } from '@tulipfarm/tables/service-contracts';
import type { TableProposalOptions } from '@tulipfarm/tables/proposals';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import { workspaceMemberMutationSchema } from '@tulipfarm/tables/workspace-members';

export const recordRequestSchema = z.object({
  requestId: z.uuid(),
  mutation: z.union([mutationSchema, workspaceMemberMutationSchema]),
});
export const recordMutationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), id: z.uuid(), token: z.uuid(), values: valuesSchema.nullable() }),
  z.object({ kind: z.literal('expired'), id: z.uuid(), token: z.uuid() }),
]);
export const recordRequestStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }),
  z.object({ status: z.literal('applied'), result: recordMutationResultSchema }),
]);
const receiptSchema = z.object({
  input_digest: z.string().regex(/^[a-f0-9]{64}$/),
  permission: z.enum(['table.row.create', 'table.row.update', 'table.row.delete']),
  result: recordMutationResultSchema,
});
type Runtime = TableProposalOptions['runtime'];
type Transaction = Parameters<TableProposalOptions['requireSources']>[0];

export function createRecordRequests(runtime: Runtime) {
  async function allowed(tx: Transaction, actor: HumanActor, tableId: string, receipt: z.infer<typeof receiptSchema>) {
    await requireTablePermission(tx, actor, tableId, receipt.permission);
    if (receipt.result.kind === 'expired') return;
    const tableIds = [
      ...new Set(
        Object.values(receipt.result.values ?? {}).flatMap(value =>
          value?.kind === 'relationship' ? [value.tableId] : [],
        ),
      ),
    ];
    for (const id of tableIds) await requireTablePermission(tx, actor, id, 'table.row.read');
  }
  async function transaction<T>(
    workspaceId: string,
    userId: string,
    tableId: string,
    requestId: string,
    operation: (tx: Transaction, actor: HumanActor, receipt: z.infer<typeof receiptSchema> | undefined) => Promise<T>,
    lock: 'read' | 'write' = 'read',
  ) {
    z.uuid().parse(tableId);
    z.uuid().parse(requestId);
    return runtime.transaction(workspaceId, executionCompatibility, async tx => {
      await lockAuthorization(tx, lock);
      const actor = await resolveHuman(tx, userId);
      await requireTablePermission(tx, actor, tableId, 'table.row.read');
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,81001))', [
        JSON.stringify([tx.schema, actor.membershipId, tableId, requestId]),
      ]);
      const receipt = receiptSchema.optional().parse(
        (
          await tx.client.query(
            `SELECT input_digest,permission,
        CASE WHEN created_at+interval '30 days'<=clock_timestamp()
          THEN jsonb_build_object('kind','expired','id',result->'id','token',result->'token') ELSE result END AS result
        FROM "${tx.schema}".tf_table_row_requests WHERE membership_id=$1 AND table_id=$2 AND request_id=$3`,
            [actor.membershipId, tableId, requestId],
          )
        ).rows[0],
      );
      if (receipt) await allowed(tx, actor, tableId, receipt);
      return operation(tx, actor, receipt);
    });
  }
  return {
    status(workspaceId: string, userId: string, tableId: string, requestId: string) {
      return transaction(workspaceId, userId, tableId, requestId, async (_tx, _actor, receipt) =>
        receipt ? { status: 'applied' as const, result: receipt.result } : { status: 'unknown' as const },
      );
    },
    mutate(workspaceId: string, userId: string, input: unknown) {
      const { requestId, mutation } = recordRequestSchema.parse(input);
      return transaction(
        workspaceId,
        userId,
        mutation.tableId,
        requestId,
        async (tx, actor, receipt) => {
          if (receipt) {
            if (receipt.input_digest !== tableProposalDigest(mutation)) throw new TableError('idempotency-conflict');
            return receipt.result;
          }
          const scoped: Runtime = {
            transaction: async (id, _range, operation) => {
              if (id !== workspaceId) throw new AccessDenied();
              return operation(tx);
            },
          };
          const records = createTableService(
            scoped,
            { readableFiles: humanReadableTableFiles },
            executionCompatibility,
          );
          const memberMutation = mutation.kind === 'member-photo' || mutation.kind === 'member-repair';
          const permission =
            mutation.kind === 'member-photo'
              ? 'table.row.update'
              : mutation.kind === 'member-repair'
                ? 'table.row.create'
                : mutation.kind === 'restore'
                  ? (await records.read(workspaceId, actor, mutation))
                    ? 'table.row.update'
                    : 'table.row.create'
                  : (`table.row.${mutation.kind}` as const);
          const result = recordMutationResultSchema.parse({
            kind: 'available',
            ...(await (memberMutation
              ? records.mutateMember(workspaceId, actor, mutation)
              : records.mutate(workspaceId, actor, mutation))),
          });
          await tx.client.query(
            `INSERT INTO "${tx.schema}".tf_table_row_requests(membership_id,table_id,request_id,input_digest,input,permission,result) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              actor.membershipId,
              mutation.tableId,
              requestId,
              tableProposalDigest(mutation),
              mutation,
              permission,
              result,
            ],
          );
          return result;
        },
        mutation.kind === 'member-repair' ? 'write' : 'read',
      );
    },
  };
}
