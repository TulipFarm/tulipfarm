import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  protectedSourceClosure,
  requireNoMcpDerived,
  sourceDependenciesSchema,
  type Actor,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { requireDraftSources } from './draft-sources.ts';
import { relation, type AgentTransaction } from './store.ts';
import type { ImportReference } from '@tulipfarm/tables/imports';

export async function requireTableSources(
  tx: AgentTransaction,
  actor: HumanActor,
  sources: readonly SourceDependency[],
) {
  await lockAuthorization(tx);
  await requireNoMcpDerived(tx, sources);
  // The storage worker cannot read these sources' tables, so a definer function checks them, at any depth.
  const allowed = async (source: SourceDependency) => {
    const row = (
      await tx.client.query(`SELECT ${relation(tx, 'tf_table_source_allowed')}($1,$2,$3) AS allowed`, [
        actor.membershipId,
        actor.userId,
        source,
      ])
    ).rows[0];
    if (!z.object({ allowed: z.boolean() }).parse(row).allowed) throw new AccessDenied();
  };
  for (const source of sources) {
    // Personal GitHub reads cannot be transferred into shared resource records or definitions.
    if (source.kind === 'github-personal') throw new AccessDenied();
    if (
      [
        'private-conversation',
        'github-source',
        'integration-source',
        'google-integration',
        'atlassian-source',
      ].includes(source.kind)
    )
      await allowed(source);
    // The requester reviews the exact change before it is saved, so their own personal memory may inform it.
    else await requireDraftSources(tx, actor, [source], new Set(), undefined, false, true, undefined, allowed);
  }
}

type KnowledgeDocumentSource = Extract<SourceDependency, { kind: 'knowledge-document' }>;

// Table execution and publication recheck sources in transactions that cannot read knowledge tables, so a definer
// function applies the knowledge gate for the requester and returns each cited document's own sources.
export function bindTableKnowledgeSources<X extends AgentTransaction & { workspaceId: string }>(
  tx: X,
  requester: HumanActor,
): X {
  const sources = async (source: KnowledgeDocumentSource) => {
    if (source.workspaceId !== tx.workspaceId) throw new AccessDenied();
    const row = (
      await tx.client.query(`SELECT ${relation(tx, 'tf_table_knowledge_sources')}($1,$2,$3) AS sources`, [
        requester.membershipId,
        requester.userId,
        source,
      ])
    ).rows[0];
    const readable = z.object({ sources: sourceDependenciesSchema.nullable() }).parse(row).sources;
    if (!readable) throw new AccessDenied();
    return readable;
  };
  const bound: X = {
    ...tx,
    knowledgeSourceDependencies: sources,
    async requireKnowledgeSource(actor, source, context) {
      if (context.runId || actor.membershipId !== requester.membershipId || actor.userId !== requester.userId)
        throw new AccessDenied();
      // Expanding the closure checks every cited document in it; the rest are checked as table sources.
      const closure = await protectedSourceClosure(bound, await sources(source));
      await requireTableSources(
        bound,
        actor,
        closure.filter(item => item.kind !== 'knowledge-document'),
      );
    },
  };
  return bound;
}

/** Returns the ids among `fileIds` the human can open now, checked in one query. */
export async function readableTableFiles(
  tx: AgentTransaction,
  actor: HumanActor,
  fileIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(z.array(z.uuid()).parse(fileIds))];
  if (!ids.length) return new Set();
  await lockAuthorization(tx);
  const rows = (
    await tx.client.query(
      `SELECT id FROM unnest($3::uuid[]) AS id WHERE ${relation(tx, 'tf_table_file_allowed')}($1,$2,id)`,
      [actor.membershipId, actor.userId, ids],
    )
  ).rows;
  return new Set(
    z
      .array(z.object({ id: z.uuid() }))
      .parse(rows)
      .map(row => row.id),
  );
}

export async function requireTableFiles(tx: AgentTransaction, actor: HumanActor, fileIds: string[]) {
  const ids = z.array(z.uuid()).max(256).parse(fileIds);
  const readable = await readableTableFiles(tx, actor, ids);
  if (ids.some(id => !readable.has(id))) throw new AccessDenied();
}

/** Composes a table service hook for a direct-human surface. Other actors can open no file. */
export const humanReadableTableFiles = (tx: AgentTransaction, actor: Actor, fileIds: readonly string[]) =>
  actor.kind === 'human' ? readableTableFiles(tx, actor, fileIds) : Promise.resolve(new Set<string>());

export async function requireTableImportAttachment(
  tx: AgentTransaction,
  actor: HumanActor,
  conversationId: string,
  reference: { attachmentId: string; contentDigest: string },
) {
  await lockAuthorization(tx);
  const row = (
    await tx.client.query(`SELECT ${relation(tx, 'tf_table_attachment_allowed')}($1,$2,$3,$4,$5) AS allowed`, [
      actor.membershipId,
      actor.userId,
      z.uuid().parse(conversationId),
      z.uuid().parse(reference.attachmentId),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(reference.contentDigest),
    ])
  ).rows[0];
  if (!z.object({ allowed: z.boolean() }).parse(row).allowed) throw new AccessDenied();
}

export async function requireTableImportReference(
  tx: AgentTransaction,
  actor: HumanActor,
  conversationId: string,
  reference: ImportReference,
) {
  if (reference.kind === 'file') return requireTableImportAttachment(tx, actor, conversationId, reference);
  await lockAuthorization(tx);
  const row = (
    await tx.client.query(`SELECT ${relation(tx, 'tf_table_import_result_allowed')}($1,$2,$3,$4) AS allowed`, [
      actor.membershipId,
      actor.userId,
      z.uuid().parse(conversationId),
      z.uuid().parse(reference.resultId),
    ])
  ).rows[0];
  if (!z.object({ allowed: z.boolean() }).parse(row).allowed) throw new AccessDenied();
}
