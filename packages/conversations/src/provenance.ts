import { z } from 'zod';
import {
  AccessDenied,
  canAccessAsset,
  canAccessTable,
  currentMember,
  denyMcpEgress,
  humanActorSchema,
  lockAuthorization,
  requireNoMcpDerived,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { requireProjectAccess } from './project-membership.ts';
import { sourceDependencySchema } from './results.ts';
import {
  artifactReferenceSchema,
  provenanceIdSchema,
  provenanceSchema,
  type ArtifactReference,
  type Provenance,
  type ProvenanceId,
  type SourceReference,
} from './provenance-contracts.ts';

export * from './provenance-contracts.ts';
export class ProvenanceConflict extends Error {
  constructor() {
    super('provenance-conflict');
  }
}
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const receiptSchema = z.object({
  id: provenanceIdSchema,
  inputs: z.array(provenanceIdSchema),
  direct: provenanceSchema,
  closure: provenanceSchema,
});
const artifactColumns = {
  message: 'message_id',
  turn: 'turn_id',
  'tool-result': 'tool_result_id',
  request: 'request_id',
  response: 'response_id',
  'approval-request': 'approval_request_id',
  'approval-resolution': 'approval_resolution_id',
} satisfies Record<ArtifactReference['kind'], string>;

function union(values: readonly Provenance[]): Provenance {
  const sources = new Map<string, SourceReference>();
  const readers = new Set<string>();
  for (const value of values) {
    for (const source of value.dependencies) sources.set(JSON.stringify(source), source);
    if (value.kind === 'legacy-unknown') for (const reader of value.originalReaders) readers.add(reader);
  }
  const dependencies = [...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, source]) => source);
  return provenanceSchema.parse(
    readers.size
      ? { kind: 'legacy-unknown', originalReaders: [...readers].sort(), dependencies }
      : { kind: 'known', dependencies },
  );
}
async function receipts(tx: AuthorizationTransaction, ids: readonly string[]) {
  const rows = z
    .array(receiptSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT id,inputs,direct,closure FROM ${table(tx, 'tf_provenance')} WHERE id=ANY($1::uuid[])`,
          [ids],
        )
      ).rows,
    );
  if (rows.length !== new Set(ids).size) throw new AccessDenied();
  return rows;
}

// Trusted producers call this inside the transaction that persists the artifact.
export async function recordProvenance(
  tx: AuthorizationTransaction,
  input: {
    id: string;
    direct: Provenance;
    inputs: readonly ProvenanceId[];
  },
): Promise<ProvenanceId> {
  const value = z
    .strictObject({ id: provenanceIdSchema, direct: provenanceSchema, inputs: z.array(provenanceIdSchema).max(512) })
    .parse(input);
  const direct = union([value.direct]);
  const inputs = new Set(value.inputs);
  for (const source of direct.dependencies)
    if (source.kind === 'project-revision') {
      const revision = z
        .object({ provenance_id: provenanceIdSchema })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT provenance_id FROM ${table(tx, 'tf_project_provenance_revisions')} WHERE id=$1 AND project_id=$2`,
              [source.revisionId, source.projectId],
            )
          ).rows[0],
        );
      if (!revision) throw new AccessDenied();
      inputs.add(revision.provenance_id);
    }
  if (inputs.has(value.id)) throw new ProvenanceConflict();
  const ordered = [...inputs].sort();
  const closure = union([direct, ...(await receipts(tx, ordered)).map(row => row.closure)]);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_provenance')} (id,inputs,direct,closure) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [value.id, ordered, JSON.stringify(direct), JSON.stringify(closure)],
  );
  const match = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'tf_provenance')} WHERE id=$1 AND inputs=$2::uuid[] AND direct=$3::jsonb AND closure=$4::jsonb`,
    [value.id, ordered, JSON.stringify(direct), JSON.stringify(closure)],
  );
  if (!match.rowCount) throw new ProvenanceConflict();
  return value.id;
}

export async function bindArtifactProvenance(
  tx: AuthorizationTransaction,
  input: { artifact: ArtifactReference; provenanceId: ProvenanceId },
) {
  const { artifact, provenanceId } = z
    .strictObject({ artifact: artifactReferenceSchema, provenanceId: provenanceIdSchema })
    .parse(input);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_provenance_artifacts')} (${artifactColumns[artifact.kind]},provenance_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [artifact.id, provenanceId],
  );
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_provenance_artifacts')} WHERE kind=$1 AND artifact_id=$2 AND provenance_id=$3`,
        [artifact.kind, artifact.id, provenanceId],
      )
    ).rowCount
  )
    throw new ProvenanceConflict();
}

export async function registerProjectRevisionProvenance(
  tx: AuthorizationTransaction,
  input: { projectId: string; revisionId: string; provenanceId: ProvenanceId },
) {
  denyMcpEgress();
  const value = z
    .strictObject({ projectId: uuidSchema, revisionId: uuidSchema, provenanceId: provenanceIdSchema })
    .parse(input);
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_project_provenance_revisions')} (id,project_id,provenance_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [value.revisionId, value.projectId, value.provenanceId],
  );
  if (
    !(
      await tx.client.query(
        `SELECT 1 FROM ${table(tx, 'tf_project_provenance_revisions')} WHERE id=$1 AND project_id=$2 AND provenance_id=$3`,
        [value.revisionId, value.projectId, value.provenanceId],
      )
    ).rowCount
  )
    throw new ProvenanceConflict();
}

export async function recordConversationResultProvenance(
  tx: AuthorizationTransaction,
  turnId: string,
): Promise<ProvenanceId> {
  denyMcpEgress();
  turnId = uuidSchema.parse(turnId);
  const result = z
    .object({ conversation_id: uuidSchema, message_id: uuidSchema, sources: z.array(sourceDependencySchema).max(1000) })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT r.conversation_id,r.message_id,r.sources FROM ${table(tx, 'tf_conversation_results')} r
    JOIN ${table(tx, 'tf_conversation_turns')} t ON t.id=r.turn_id AND t.conversation_id=r.conversation_id AND t.response_message_id=r.message_id AND t.status='completed'
    JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id=r.message_id AND m.conversation_id=r.conversation_id AND m.author_kind='assistant'
    WHERE r.turn_id=$1 AND r.publication='private'`,
          [turnId],
        )
      ).rows[0],
    );
  if (!result) throw new AccessDenied();
  await requireNoMcpDerived(tx, [
    { kind: 'private-conversation', conversationId: result.conversation_id },
    ...result.sources,
  ]);
  const privateChats = new Set([result.conversation_id]);
  const dependencies: SourceReference[] = [];
  let unknown = false;
  const memoryOwners = new Set<string>();
  for (const source of result.sources) {
    switch (source.kind) {
      case 'table':
        dependencies.push({ kind: 'table-read', tableId: source.tableId });
        break;
      case 'integration-source':
        dependencies.push(source);
        break;
      case 'private-conversation':
        privateChats.add(source.conversationId);
        break;
      case 'public-web':
        break;
      case 'unknown':
        unknown = true;
        break;
      case 'personal-memory':
        memoryOwners.add(source.membershipId);
        break;
      case 'workflow-definition':
      case 'workflow-provider':
      case 'knowledge-document':
      case 'tulipfarm-file':
      case 'google-file':
      case 'private-task':
      case 'mcp-integration':
      case 'github-personal':
      case 'shared-slack-turn':
      case 'table-schema':
      case 'table-rows':
      case 'github-source':
      case 'atlassian-source':
      case 'google-integration':
      case 'agent-definition':
      case 'workspace-skill':
      case 'creation-team':
      case 'unavailable':
        throw new AccessDenied();
      default: {
        const exhaustive: never = source;
        return exhaustive;
      }
    }
  }
  const owners = z
    .array(z.object({ id: uuidSchema, owner_membership_id: uuidSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,owner_membership_id FROM ${table(tx, 'tf_conversations')} WHERE id=ANY($1::uuid[]) AND kind='private'`,
          [[...privateChats]],
        )
      ).rows,
    );
  if (owners.length !== privateChats.size) throw new AccessDenied();
  // Personal memory may only reach readers who own it.
  if ([...memoryOwners].some(membershipId => owners.some(owner => owner.owner_membership_id !== membershipId)))
    throw new AccessDenied();
  for (const owner of owners) dependencies.push({ kind: 'requester-only', membershipId: owner.owner_membership_id });
  const direct: Provenance = unknown
    ? { kind: 'legacy-unknown', originalReaders: owners.map(owner => owner.owner_membership_id), dependencies }
    : { kind: 'known', dependencies };
  const provenanceId = await recordProvenance(tx, { id: result.message_id, direct: union([direct]), inputs: [] });
  for (const artifact of [
    { kind: 'message', id: result.message_id },
    { kind: 'turn', id: turnId },
  ] satisfies ArtifactReference[]) {
    await bindArtifactProvenance(tx, { artifact, provenanceId });
  }
  return provenanceId;
}

async function readable(tx: AuthorizationTransaction, reader: HumanActor, source: SourceReference): Promise<boolean> {
  switch (source.kind) {
    case 'requester-only':
      return source.membershipId === reader.membershipId;
    case 'table-read':
    case 'schema-read': {
      if (
        !(await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_table_catalog')} WHERE id=$1`, [source.tableId]))
          .rowCount
      )
        return false;
      return (
        (await canAccessTable(tx, reader, source.tableId, 'table.row.read')) ||
        (source.kind === 'schema-read' && (await canAccessTable(tx, reader, source.tableId, 'table.schema.manage')))
      );
    }
    case 'integration-source':
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_integrations')} c JOIN ${table(tx, 'tf_integration_sources')} s ON s.integration_id=c.id WHERE c.id=$1 AND s.id=$2 AND c.enabled AND c.deleted_at IS NULL`,
            [source.integrationId, source.sourceId],
          )
        ).rowCount
      )
        return false;
      return (
        (await canAccessAsset(tx, reader, source.integrationId, 'integration.use')) &&
        (await canAccessAsset(tx, reader, source.sourceId, 'github.issue.read'))
      );
    case 'project-revision':
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_project_provenance_revisions')} WHERE id=$1 AND project_id=$2`,
            [source.revisionId, source.projectId],
          )
        ).rowCount
      )
        return false;
      await requireProjectAccess(tx, reader, source.projectId);
      return true;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

// Source eligibility never replaces authorization of the containing chat or project.
export async function artifactSourceVisibility(
  tx: AuthorizationTransaction,
  input: { reader: HumanActor; artifacts: readonly ArtifactReference[] },
) {
  const { reader, artifacts } = z
    .strictObject({ reader: humanActorSchema, artifacts: z.array(artifactReferenceSchema).max(512) })
    .parse(input);
  await lockAuthorization(tx);
  await currentMember(tx, reader);
  const bindings = z
    .array(
      z.object({
        kind: artifactReferenceSchema.shape.kind,
        artifact_id: uuidSchema,
        provenance_id: provenanceIdSchema,
        closure: provenanceSchema,
      }),
    )
    .parse(
      (
        await tx.client.query(
          `SELECT b.kind,b.artifact_id,b.provenance_id,p.closure FROM ${table(tx, 'tf_provenance_artifacts')} b JOIN ${table(tx, 'tf_provenance')} p ON p.id=b.provenance_id WHERE (b.kind,b.artifact_id) IN (SELECT kind,id::uuid FROM jsonb_to_recordset($1::jsonb) AS refs(kind text,id text))`,
          [JSON.stringify(artifacts)],
        )
      ).rows,
    );
  const policies = new Map(bindings.map(row => [`${row.kind}:${row.artifact_id}`, row]));
  const decisions = new Map<string, boolean>();
  const result = [];
  for (const artifact of artifacts) {
    const binding = policies.get(`${artifact.kind}:${artifact.id}`);
    const policy = binding?.closure;
    let visible = policy !== undefined;
    if (policy) {
      if (policy.kind === 'legacy-unknown') visible = policy.originalReaders.every(id => id === reader.membershipId);
      for (const source of policy.dependencies) {
        const key = JSON.stringify(source);
        if (!decisions.has(key)) {
          try {
            decisions.set(key, await readable(tx, reader, source));
          } catch (error) {
            if (!(error instanceof AccessDenied)) throw error;
            decisions.set(key, false);
          }
        }
        if (!decisions.get(key)) visible = false;
      }
    }
    result.push({ artifact, provenanceId: binding?.provenance_id ?? null, visible });
  }
  return result;
}
