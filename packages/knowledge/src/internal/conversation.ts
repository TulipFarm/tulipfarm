import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  denyMcpEgress,
  humanActorSchema,
  protectedSourceClosure,
  sourceDependenciesSchema,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { parseKnowledgeDocument } from '../parser.ts';
import { KnowledgeError, citationSchema, knowledgeLimits, lexicalInput, revisionInput } from './contracts.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import { sqlExternalAuthority } from './external-authority.ts';
import type { createKnowledgeEmbeddings } from './embeddings.ts';
import { requireConversationReader } from './conversation-authority.ts';
import type { Clock } from '@tulipfarm/memory-core/ports/runtime';
import { systemClock } from '../host-ports.ts';

export const conversationKnowledgeInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  conversationId: z.uuid(),
  generation: z.number().int().nonnegative(),
  coverageMessageId: z.uuid(),
  coveredThrough: z.number().int().positive(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(640)
    .transform(title => title.slice(0, 512).replace(/[\uD800-\uDBFF]$/u, '')),
  text: z
    .string()
    .min(1)
    .max(10 * 1024 * 1024),
  sources: sourceDependenciesSchema,
  requester: humanActorSchema,
  resumeCommandId: z.uuid().optional(),
});
export type ConversationKnowledgeInput = z.infer<typeof conversationKnowledgeInputSchema>;
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const identity = (text: string) => {
  const hex = hash(text);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export function createConversationKnowledge({
  runtime,
  embeddings,
  clock = systemClock,
}: Pick<KnowledgeOptions, 'runtime'> & {
  embeddings?: Pick<ReturnType<typeof createKnowledgeEmbeddings>, 'due' | 'resumeDocument'>;
  clock?: Clock;
}) {
  const store = createKnowledgeStore({ runtime, ...sqlExternalAuthority() });
  type Transaction = Parameters<typeof store.bind>[0];
  const table = (tx: Transaction, name: string) => qualified(tx.schema, name);
  async function fence(tx: Transaction, input: ConversationKnowledgeInput) {
    if (tx.commonVersion < 1) throw new KnowledgeError('adapter-required');
    const row = await tx.client.query(
      `SELECT c.id FROM ${table(tx, 'tf_conversations')} c
      JOIN ${table(tx, 'tf_conversation_maintenance')} j ON j.conversation_id=c.id AND j.generation=c.activity_generation
      JOIN ${table(tx, 'tf_conversation_messages')} m ON m.id=j.coverage_message_id AND m.conversation_id=c.id
      WHERE c.id=$1 AND c.is_closed AND c.activity_generation=$2 AND c.deleted_at IS NULL AND c.kind='private'
        AND j.coverage_message_id=$3 AND j.covered_through=$4 AND j.recap=$5 AND j.sources=$6::jsonb
        AND j.requester_user_id=$7 AND j.requester_membership_id=$8
        AND j.resume_command_id IS NOT DISTINCT FROM $9::uuid
        AND j.state IN ('publishing','ready')
        AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'tf_conversation_turns')} t WHERE t.conversation_id=c.id AND t.status IN ('queued','processing','waiting','reconciling'))
      FOR UPDATE OF c`,
      [
        input.conversationId,
        input.generation,
        input.coverageMessageId,
        input.coveredThrough,
        input.text,
        JSON.stringify(input.sources),
        input.requester.userId,
        input.requester.membershipId,
        input.resumeCommandId ?? null,
      ],
    );
    if (!row.rowCount) throw new AccessDenied();
  }
  async function publish(value: ConversationKnowledgeInput) {
    denyMcpEgress();
    const input = conversationKnowledgeInputSchema.parse(value);
    const documentId = identity(`conversation-document:${input.workspaceId}:${input.conversationId}`);
    const sourceId = identity(`conversation-source:${input.workspaceId}`);
    const revisionId = identity(`conversation-revision:${documentId}:${input.generation}:${input.coveredThrough}`);
    const publicationId = identity(`conversation-publication:${revisionId}`);
    await store.transaction(input.workspaceId, input.requester, false, tx => fence(tx, input));
    const bytes = Buffer.from(input.text, 'utf8');
    const parsed = await parseKnowledgeDocument({ bytes, filename: 'conversation.md', mediaType: 'text/markdown' });
    const published = await store.transaction(input.workspaceId, input.requester, true, async (tx, actor) => {
      await fence(tx, input);
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_knowledge_sources')} (id,provider,account_namespace,selection,owner_membership_id)
        VALUES ($1,'conversation',$2,'conversations',$3) ON CONFLICT DO NOTHING`,
        [sourceId, input.workspaceId, actor.membershipId],
      );
      await store.source(tx, actor, sourceId, true);
      await requireConversationReader(tx, actor, sourceId, input.conversationId);
      // The chat audience is checked by its provider, not the private-only legacy
      // source variant. Only this root is removed; all external dependencies remain.
      const sources = await protectedSourceClosure(
        tx,
        input.sources.filter(
          source => source.kind !== 'private-conversation' || source.conversationId !== input.conversationId,
        ),
      );
      if (sources.some(source => source.kind === 'knowledge-document' && source.documentId === documentId))
        throw new AccessDenied();
      const previous = (
        await tx.client.query(`SELECT observed_revision_id FROM ${table(tx, 'tf_knowledge_documents')} WHERE id=$1`, [
          documentId,
        ])
      ).rows[0];
      const saved = z
        .object({ title: z.string() })
        .optional()
        .parse(
          (await tx.client.query(`SELECT title FROM ${table(tx, 'tf_knowledge_revisions')} WHERE id=$1`, [revisionId]))
            .rows[0],
        );
      await store.observe(
        tx,
        actor,
        revisionInput.parse({
          id: revisionId,
          documentId,
          sourceId,
          nativeId: input.conversationId,
          expectedRevisionId: previous?.observed_revision_id ?? null,
          sourceRevision: `${input.generation}:${input.coveredThrough}:${input.coverageMessageId}`,
          title: saved?.title ?? input.title,
          canonicalUrl: null,
          original: { kind: 'object', key: revisionId, sha256: hash(bytes), bytes: bytes.byteLength },
          parserProfile: parsed.profile,
          sources,
        }),
        true,
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_knowledge_conversation_revisions')}
        (revision_id,conversation_id,generation,covered_through,coverage_message_id,requester_user_id,requester_membership_id,original_text)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          revisionId,
          input.conversationId,
          input.generation,
          input.coveredThrough,
          input.coverageMessageId,
          actor.userId,
          actor.membershipId,
          input.text,
        ],
      );
      await store.publish(
        tx,
        actor,
        lexicalInput.parse({
          id: publicationId,
          documentId,
          revisionId,
          markdown: parsed.markdown,
          pages: parsed.pages,
          tokens: parsed.tokens,
          chunks: parsed.chunks,
        }),
        { filename: 'conversation.md' },
      );
      const work = (
        await tx.client.query(`SELECT embedding FROM ${table(tx, 'tf_knowledge_work')} WHERE revision_id=$1`, [
          revisionId,
        ])
      ).rows[0];
      return { documentId, revisionId, embeddingStatus: z.string().parse(work?.embedding) };
    });
    if (input.resumeCommandId) {
      if (!embeddings) throw new KnowledgeError('adapter-required');
      await embeddings.due(input.workspaceId);
      const status = await embeddings.resumeDocument(
        input.workspaceId,
        input.requester.userId,
        documentId,
        input.resumeCommandId,
      );
      return { ...published, embeddingStatus: status.state };
    }
    return published;
  }
  async function evidence(workspaceId: string, userId: string, value: unknown) {
    const citation = citationSchema.parse(value);
    return store.transaction(workspaceId, userId, false, async (tx, actor) => {
      const { revision, origin } = await store.eligible(tx, actor, citation);
      if (origin.provider !== 'conversation') throw new AccessDenied();
      const row = z
        .object({ conversation_id: z.uuid(), heading: z.string(), passage: z.string() })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT r.conversation_id,c.heading,c.passage FROM ${table(tx, 'tf_knowledge_conversation_revisions')} r
        JOIN ${table(tx, 'tf_knowledge_chunks')} c ON c.publication_id=$2 AND c.ordinal=$3 WHERE r.revision_id=$1`,
              [revision.id, citation.publicationId, citation.ordinal],
            )
          ).rows[0],
        );
      if (!row) throw new AccessDenied();
      return {
        title: revision.title,
        text: row.passage,
        heading: row.heading,
        citation,
        original: { kind: 'conversation' as const, conversationId: row.conversation_id },
        validUntil: new Date(clock.now() + knowledgeLimits.permissionAgeMs).toISOString(),
      };
    });
  }
  async function original(workspaceId: string, userId: string, documentId: string, expectedRevisionId?: string) {
    return store.transaction(workspaceId, userId, false, async (tx, actor) => {
      const doc = await store.document(tx, z.uuid().parse(documentId));
      const source = await store.source(tx, actor, doc.source_id);
      if (source.provider !== 'conversation' || !doc.observed_revision_id || !doc.lexical_publication_id)
        throw new AccessDenied();
      if (expectedRevisionId !== undefined && expectedRevisionId !== doc.observed_revision_id)
        throw new KnowledgeError('superseded');
      const { revision } = await store.eligible(tx, actor, {
        kind: 'knowledge-document',
        workspaceId,
        documentId,
        sourceId: source.id,
        revisionId: doc.observed_revision_id,
        publicationId: doc.lexical_publication_id,
        accessEpoch: source.access_epoch,
      });
      const row = z
        .object({ original_text: z.string() })
        .parse(
          (
            await tx.client.query(
              `SELECT original_text FROM ${table(tx, 'tf_knowledge_conversation_revisions')} WHERE revision_id=$1`,
              [revision.id],
            )
          ).rows[0],
        );
      const bytes = Buffer.from(row.original_text, 'utf8');
      if (hash(bytes) !== revision.original.sha256 || bytes.byteLength !== revision.original.bytes)
        throw new KnowledgeError('integrity');
      return { bytes, filename: 'conversation.md', mediaType: 'text/markdown' };
    });
  }
  return { publish, evidence, original };
}
