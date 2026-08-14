/** Slack membership `undefined` means unverifiable and denying, never unrestricted. */

export type SlackChannelKind = "public" | "private" | "dm" | "group_dm";

export interface SlackKnowledgeChannel {
  readonly id: string;
  readonly name: string;
  readonly kind: SlackChannelKind;
  readonly teamId: string;
  readonly archived: boolean;
  readonly classification?: readonly string[];
}

export interface SlackKnowledgeMessage {
  readonly channelId: string;
  /** Slack message timestamp; the message identity and its ordering key. */
  readonly ts: string;
  readonly threadTs?: string;
  readonly userExternalId: string;
  readonly text: string;
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

/** Per-channel checkpoints prevent one bad channel from stalling or skipping the workspace. */
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
