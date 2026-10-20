import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  requireNoMcpDerived,
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
    ) {
      const row = (
        await tx.client.query(`SELECT ${relation(tx, 'tf_table_source_allowed')}($1,$2,$3) AS allowed`, [
          actor.membershipId,
          actor.userId,
          source,
        ])
      ).rows[0];
      if (!z.object({ allowed: z.boolean() }).parse(row).allowed) throw new AccessDenied();
    } else await requireDraftSources(tx, actor, [source]);
  }
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
