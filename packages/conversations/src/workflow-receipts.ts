import { z } from 'zod';
import { AccessDenied, hasWorkflowGrant, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { requireWorkflowSources } from './source-access.ts';
import { workflowReferenceSchema } from './contracts.ts';

export async function workflowReferences(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  row: { tool: string; status: string; output?: unknown; sources?: unknown },
) {
  if (row.status !== 'completed' || !['workflows.list', 'workflows.read'].includes(row.tool)) return undefined;
  const result = z.object({ result: z.unknown() }).safeParse(row.output);
  if (!result.success) return undefined;
  const listed =
    row.tool === 'workflows.list'
      ? z
          .object({ workflows: z.array(z.object({ id: z.uuid(), revision: z.uuid(), name: z.string() })) })
          .safeParse(result.data.result)
      : null;
  const read =
    row.tool === 'workflows.read'
      ? z
          .object({ workflowId: z.uuid(), revision: z.uuid(), definition: z.object({ name: z.string() }) })
          .safeParse(result.data.result)
      : null;
  const references = listed?.success
    ? listed.data.workflows.map(item => ({ workflowId: item.id, revision: item.revision, name: item.name }))
    : read?.success
      ? [{ workflowId: read.data.workflowId, revision: read.data.revision, name: read.data.definition.name }]
      : [];
  const allowed: z.infer<typeof workflowReferenceSchema>[] = [];
  for (const reference of references) {
    try {
      await requireWorkflowSources(tx, actor, [
        ...z.array(z.unknown()).parse(row.sources ?? []),
        { kind: 'workflow-definition', workflowId: reference.workflowId, revision: reference.revision },
      ]);
      allowed.push(reference);
    } catch (error) {
      if (!(error instanceof AccessDenied)) throw error;
    }
  }
  return allowed;
}

/** The workflows a saved tool result named that the viewer can read now; the rest stay unnamed. */
export async function readableWorkflows(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  workflows: readonly { id: string; name: string }[] | undefined,
) {
  const readable: { id: string; name: string }[] = [];
  for (const workflow of workflows ?? [])
    if (await hasWorkflowGrant(tx, actor.membershipId, workflow.id, 'read')) readable.push(workflow);
  return readable;
}
