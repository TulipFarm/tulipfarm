import { z } from 'zod';
import {
  AccessDenied,
  sourceDependenciesSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  createChannelProvider,
  threadSnapshotSchema,
  messageSchema,
  currentSlackMessage,
  sameSlackMessage,
} from '@tulipfarm/slack';
import { matchesSlackSnapshot } from '@tulipfarm/slack';
import { requireDraftSources } from './draft-sources.ts';
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
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);

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
  async function sources(
    tx: AuthorizationTransaction,
    workspaceId: string,
    actor: HumanActor,
    eventId: string,
    visited = new Set<string>(),
    publicOnly = false,
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
      } else await requireDraftSources(tx, actor, [dependency], new Set(), undefined, publicOnly);
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
    if (!sameSlackMessage(await currentSlackMessage(tx, eventId), request)) throw new AccessDenied();
    const observed = await provider.observe(tx, workspaceId, actor, slackSource(root));
    const current = new Map(observed.messages.map(message => [message.ts, message]));
    if (snapshot.some(message => !matchesSlackSnapshot(current.get(message.ts), message))) throw new AccessDenied();
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
      throw new AccessDenied();
    if (request.channel.startsWith('D')) {
      const privateContext = await provider.observe(tx, workspaceId, actor, {
        ...slackSource(root),
        channel: request.channel,
        rootTs: request.thread_ts ?? request.ts,
      });
      if (!privateContext.messages.some(message => matchesSlackSnapshot(message, request))) throw new AccessDenied();
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
      const publication = publications.find(item => item.message_ts === message.ts && item.text === message.text);
      if (!publication) throw new AccessDenied();
      await sources(tx, workspaceId, actor, publication.event_id, new Set(visited));
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
    } catch {
      return { kind: 'Undeliverable' };
    }
    if (!shared || !enabled) return { kind: 'PrivateOnly' };
    return { kind: 'ChannelAllowed', channel: root.channel, rootTs: root.root_ts };
  }
  return { sources, context, decide };
}
