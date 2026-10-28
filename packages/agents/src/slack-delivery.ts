import { z } from 'zod';
import { errorType, log } from '@tulipfarm/observability';
import {
  AccessDenied,
  SourceAuthorizationUnavailable,
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  createChannelProvider,
  threadSnapshotSchema,
  messageSchema,
  currentSlackMessage,
  sameSlackMessage,
} from '@tulipfarm/slack';
import { matchesSlackSnapshot, sameSlackPublicationText } from '@tulipfarm/slack';
import { requireDraftSources } from './draft-sources.ts';
import { SlackAdmissionDenied, slackReplyFailureNotices } from './slack-rejections.ts';
import { requireNoMcpDerived } from '@tulipfarm/access';

export const slackRootSchema = z.object({
  id: z.uuid(),
  installation_id: z.uuid(),
  generation: z.number().int(),
  channel: z.string(),
  root_ts: z.string(),
  agent_id: z.uuid().nullable(),
});
export type SlackRoot = z.infer<typeof slackRootSchema>;
export const slackSource = (root: SlackRoot) => ({
  installationId: root.installation_id,
  generation: root.generation,
  channel: root.channel,
  rootTs: root.root_ts,
});
export type SlackDelivery =
  | { kind: 'ChannelAllowed'; channel: string; rootTs: string }
  | { kind: 'PrivateOnly' }
  | { kind: 'Undeliverable' };
type Provider = ReturnType<typeof createChannelProvider>;
type Observation = Awaited<ReturnType<Provider['observe']>>;
type ChannelSource = Parameters<Provider['observe']>[3];
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);

// A knowledge citation pins the revision that was current when the answer was written. Re-indexing a document
// supersedes that revision, which would otherwise make every follow-up in the thread fail forever. A prior answer is
// therefore checked against the document's current revision; the source, its access epoch and the requester's
// proof are still required, so revoked or removed access continues to deny.
async function currentKnowledgeRevision(tx: AuthorizationTransaction, dependency: SourceDependency) {
  if (dependency.kind !== 'knowledge-document') return dependency;
  const documents = table(tx, 'tf_knowledge_documents');
  const installed = (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [documents])).rows[0]
    ?.installed;
  if (!installed) return dependency;
  const current = z
    .object({ observed_revision_id: z.uuid(), lexical_publication_id: z.uuid() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT observed_revision_id,lexical_publication_id FROM ${documents} WHERE id=$1 AND source_id=$2 AND tombstoned_at IS NULL AND observed_revision_id IS NOT NULL AND lexical_publication_id IS NOT NULL`,
          [dependency.documentId, dependency.sourceId],
        )
      ).rows[0],
    );
  return current
    ? { ...dependency, revisionId: current.observed_revision_id, publicationId: current.lexical_publication_id }
    : dependency;
}

export function createSlackDelivery(
  provider: Provider,
  namedSources: (
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    eventId: string,
    publicOnly: boolean,
  ) => Promise<void>,
) {
  // Each prior turn in a thread re-checks the same thread and the turns before it, so without reuse one reply repeats
  // the same Slack reads exponentially while it holds the workspace lock. Within one transaction an observation and a
  // passed check stay valid, so both are reused; a failure is never cached.
  const checks = new WeakMap<
    AuthorizationTransaction,
    { observed: Map<string, Promise<Observation>>; verified: Set<string> }
  >();
  function checksFor(tx: AuthorizationTransaction) {
    let entry = checks.get(tx);
    if (!entry) checks.set(tx, (entry = { observed: new Map(), verified: new Set() }));
    return entry;
  }
  function observe(tx: AuthorizationTransaction, workspaceId: string, actor: HumanActor, source: ChannelSource) {
    const { observed } = checksFor(tx);
    const key = JSON.stringify([
      workspaceId,
      actor.membershipId,
      actor.userId,
      source.installationId,
      source.generation,
      source.channel,
      source.rootTs,
    ]);
    let result = observed.get(key);
    if (!result) {
      result = provider.observe(tx, workspaceId, actor, source);
      observed.set(key, result);
      result.catch(() => observed.delete(key));
    }
    return result;
  }
  async function sources(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    eventId: string,
    visited = new Set<string>(),
    publicOnly = false,
  ): Promise<void> {
    const { verified } = checksFor(tx);
    const key = JSON.stringify([workspaceId, actor.membershipId, actor.userId, eventId, publicOnly]);
    if (verified.has(key)) return;
    await verifySources(tx, workspaceId, actor, eventId, visited, publicOnly);
    verified.add(key);
  }
  async function verifySources(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    eventId: string,
    visited: Set<string>,
    publicOnly: boolean,
  ): Promise<void> {
    if (visited.has(eventId)) throw new AccessDenied();
    visited.add(eventId);
    if (visited.size > 100) throw new AccessDenied();
    const row = z
      .object({
        root: slackRootSchema,
        thread_snapshot: threadSnapshotSchema,
        request_snapshot: messageSchema,
        history_event_ids: z.array(z.uuid()),
        sources: sourceDependenciesSchema,
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT row_to_json(r) AS root,t.thread_snapshot,t.request_snapshot,t.history_event_ids,v.sources FROM ${table(tx, 'tf_slack_default_turns')} t JOIN ${table(tx, 'tf_slack_agent_branches')} b ON b.id=t.branch_id JOIN ${table(tx, 'tf_slack_channel_roots')} r ON r.id=b.root_id JOIN ${table(tx, 'tf_conversation_results')} v ON v.turn_id=t.turn_id WHERE t.event_id=$1`,
            [eventId],
          )
        ).rows[0],
      );
    if (!row) {
      await namedSources(tx, workspaceId, actor, eventId, publicOnly);
      return;
    }
    await requireNoMcpDerived(tx, row.sources);
    await context(tx, workspaceId, actor, row.root, eventId, row.thread_snapshot, row.request_snapshot, visited);
    for (const dependency of row.sources) {
      if (dependency.kind === 'shared-slack-turn') {
        if (dependency.eventId !== eventId)
          await sources(tx, workspaceId, actor, dependency.eventId, new Set(visited), publicOnly);
      } else
        await requireDraftSources(
          tx,
          actor,
          [await currentKnowledgeRevision(tx, dependency)],
          new Set(),
          undefined,
          publicOnly,
        );
    }
    for (const previous of row.history_event_ids)
      await sources(tx, workspaceId, actor, previous, new Set(visited), publicOnly);
  }
  async function context(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    root: SlackRoot,
    eventId: string,
    snapshot: z.infer<typeof threadSnapshotSchema>,
    request: z.infer<typeof messageSchema>,
    visited = new Set<string>(),
  ) {
    if (!sameSlackMessage(await currentSlackMessage(tx, eventId), request))
      throw new SlackAdmissionDenied('request-changed');
    const observed = await observe(tx, workspaceId, actor, slackSource(root));
    const current = new Map(observed.messages.map(message => [message.ts, message]));
    if (snapshot.some(message => !matchesSlackSnapshot(current.get(message.ts), message)))
      throw new SlackAdmissionDenied('thread-changed');
    const changes = z
      .array(z.object({ message_ts: z.string(), message: messageSchema.nullable() }))
      .parse(
        (
          await tx.client.query(
            `SELECT message_ts,message FROM ${table(tx, 'tf_slack_message_changes')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND message_ts=ANY($4::text[])`,
            [root.installation_id, root.generation, root.channel, snapshot.map(message => message.ts)],
          )
        ).rows,
      );
    if (
      changes.some(
        change =>
          !change.message ||
          !snapshot.some(
            message => message.ts === change.message_ts && matchesSlackSnapshot(change.message ?? undefined, message),
          ),
      )
    )
      throw new SlackAdmissionDenied('message-edited');
    if (request.channel.startsWith('D')) {
      const privateContext = await observe(tx, workspaceId, actor, {
        ...slackSource(root),
        channel: request.channel,
        rootTs: request.thread_ts ?? request.ts,
      });
      if (!privateContext.messages.some(message => matchesSlackSnapshot(message, request)))
        throw new SlackAdmissionDenied('private-context-missing');
    }
    const publications = z
      .array(z.object({ message_ts: z.string(), event_id: z.uuid(), text: z.string() }))
      .parse(
        (
          await tx.client.query(
            `SELECT message_ts,event_id,text FROM ${table(tx, 'tf_slack_publications')} WHERE installation_id=$1 AND generation=$2 AND channel=$3 AND message_ts=ANY($4::text[])`,
            [root.installation_id, root.generation, root.channel, snapshot.map(message => message.ts)],
          )
        ).rows,
      );
    for (const message of snapshot.filter(message => message.user === observed.botUserId)) {
      // Only our bot can post or edit as its user, and edits are recorded as message changes above. Slack returns a
      // reformatted copy of the text we posted, so the words, not Slack's whitespace or link markup, must match.
      const publication = publications.find(
        item => item.message_ts === message.ts && sameSlackPublicationText(item.text, message.text),
      );
      if (!publication) {
        if (slackReplyFailureNotices.some(notice => sameSlackPublicationText(notice, message.text))) continue;
        throw new SlackAdmissionDenied('publication-unverified');
      }
      try {
        await sources(tx, workspaceId, actor, publication.event_id, new Set(visited));
      } catch (error) {
        if (
          error instanceof AccessDenied &&
          !(error instanceof SlackAdmissionDenied) &&
          !(error instanceof SourceAuthorizationUnavailable)
        )
          throw new SlackAdmissionDenied('prior-answer-sources');
        throw error;
      }
    }
    return observed;
  }
  async function decide(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    root: SlackRoot,
    eventId: string,
    shared: boolean,
    enabled: boolean,
  ): Promise<SlackDelivery> {
    try {
      await sources(tx, workspaceId, actor, eventId);
    } catch (error) {
      // Log only a fixed reason code or the error class, never the Slack content behind it.
      log('warn', 'activity', 'call_failed', {
        operation: 'slack.delivery.decide',
        outcome: 'undeliverable',
        'error.type':
          error instanceof SlackAdmissionDenied
            ? error.reason
            : error instanceof AccessDenied
              ? 'access-denied'
              : errorType(error),
        'slack.event_id': eventId,
      });
      return { kind: 'Undeliverable' };
    }
    if (!shared || !enabled) return { kind: 'PrivateOnly' };
    return { kind: 'ChannelAllowed', channel: root.channel, rootTs: root.root_ts };
  }
  return { sources, context, decide };
}
