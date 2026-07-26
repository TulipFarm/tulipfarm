/**
 * Provider-neutral Slack Knowledge boundary (SPEC §15: concrete transports live in
 * `apps/integration-worker`, never here).
 *
 * `listMembers` returning `undefined` means "membership could not be established", which becomes an
 * `unverifiable` source that denies on retrieval. It never means "no restrictions" — a private
 * channel whose membership we cannot read is the exact case that must not become readable.
 */

export type SlackChannelKind = "public" | "private" | "dm" | "group_dm";

export interface SlackKnowledgeChannel {
  readonly id: string;
  readonly name: string;
  readonly kind: SlackChannelKind;
  readonly teamId: string;
  readonly archived: boolean;
  /** Classification labels configured for this channel; absent falls back to the kind default. */
  readonly classification?: readonly string[];
}

export interface SlackKnowledgeMessage {
  readonly channelId: string;
  /** Slack message timestamp; the message identity and its ordering key. */
  readonly ts: string;
  readonly threadTs?: string;
  readonly userExternalId: string;
  readonly text: string;
  /** Set when the message was edited; becomes the chunk revision. */
  readonly editedTs?: string;
  /** Tombstone from the change feed: the message text must be removed from the index. */
  readonly deleted?: boolean;
}

export interface SlackKnowledgeApiPort {
  listChannels(): Promise<readonly SlackKnowledgeChannel[]>;
  /** `undefined` = membership unreadable. Never return `[]` to mean "unknown". */
  listMembers(channelId: string): Promise<readonly string[] | undefined>;
  listMessages(input: { channelId: string; cursor?: string; pageLimit: number }): Promise<{
    readonly messages: readonly SlackKnowledgeMessage[];
    readonly nextCursor?: string;
  }>;
}

export interface SlackKnowledgeCheckpoint {
  readonly integrationId: string;
  readonly channelId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

/**
 * Durable per-channel resume position. Per channel rather than per workspace so one unreadable or
 * failing channel cannot stall, or silently skip, every other channel's sync.
 */
export interface SlackKnowledgeCheckpointStore {
  load(integrationId: string, channelId: string): Promise<SlackKnowledgeCheckpoint | undefined>;
  save(checkpoint: SlackKnowledgeCheckpoint): Promise<void>;
}

export class InMemorySlackKnowledgeCheckpointStore implements SlackKnowledgeCheckpointStore {
  private readonly byChannel = new Map<string, SlackKnowledgeCheckpoint>();

  async load(
    integrationId: string,
    channelId: string
  ): Promise<SlackKnowledgeCheckpoint | undefined> {
    return this.byChannel.get(`${integrationId}:${channelId}`);
  }

  async save(checkpoint: SlackKnowledgeCheckpoint): Promise<void> {
    this.byChannel.set(`${checkpoint.integrationId}:${checkpoint.channelId}`, checkpoint);
  }
}
