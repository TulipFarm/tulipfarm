import {
  collectPages,
  type SlackChannelKind,
  type SlackKnowledgeApiPort,
  type SlackKnowledgeChannel,
  type SlackKnowledgeMessage,
} from "@tulipfarm/integrations";

/** App-local, read-only Slack Web API transport for knowledge indexing; never posts or mutates. */

const SLACK_API_BASE_URL = "https://slack.com/api";

/** Slack error codes meaning "we cannot see this," never "no one can access this." */
const NO_ACCESS_ERROR_CODES = new Set([
  "channel_not_found",
  "not_in_channel",
  "missing_scope",
  "account_inactive",
  "restricted_action",
]);

class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(`slack_api_error:${code}`);
  }
}

interface SlackConversationsListChannel {
  readonly id: string;
  readonly name?: string;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
  readonly is_private?: boolean;
  readonly is_archived?: boolean;
  readonly user?: string;
}

interface SlackHistoryMessage {
  readonly ts: string;
  readonly user?: string;
  readonly text?: string;
  readonly thread_ts?: string;
  readonly edited?: { readonly ts?: string };
  readonly subtype?: string;
}

export interface SlackHttpKnowledgeApiOptions {
  readonly token: string;
  readonly teamId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class SlackHttpKnowledgeApi implements SlackKnowledgeApiPort {
  private readonly token: string;
  private readonly teamId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SlackHttpKnowledgeApiOptions) {
    this.token = options.token;
    this.teamId = options.teamId;
    this.baseUrl = options.baseUrl ?? SLACK_API_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async listChannels(): Promise<readonly SlackKnowledgeChannel[]> {
    const channels = await collectPages<SlackConversationsListChannel>(
      async (cursor) => {
        const page = await this.call<{
          channels: SlackConversationsListChannel[];
          response_metadata?: { next_cursor?: string };
        }>("conversations.list", {
          types: "public_channel,private_channel,mpim,im",
          exclude_archived: "false",
          limit: "200",
          ...(cursor === undefined ? {} : { cursor }),
        });
        const nextCursor = page.response_metadata?.next_cursor;
        return {
          items: page.channels,
          ...(nextCursor ? { nextCursor } : {}),
        };
      },
      { maxPages: 25, maxItems: 5000 }
    );

    return channels.map((channel) => ({
      id: channel.id,
      name: channel.name ?? channel.id,
      kind: channelKind(channel),
      teamId: this.teamId,
      archived: channel.is_archived ?? false,
    }));
  }

  async listMembers(channelId: string): Promise<readonly string[] | undefined> {
    try {
      return await collectPages<string>(
        async (cursor) => {
          const page = await this.call<{
            members: string[];
            response_metadata?: { next_cursor?: string };
          }>("conversations.members", {
            channel: channelId,
            limit: "200",
            ...(cursor === undefined ? {} : { cursor }),
          });
          const nextCursor = page.response_metadata?.next_cursor;
          return {
            items: page.members,
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
        { maxPages: 100, maxItems: 50_000 }
      );
    } catch (error) {
      if (error instanceof SlackApiError && NO_ACCESS_ERROR_CODES.has(error.code)) {
        return undefined;
      }
      throw error;
    }
  }

  async listMessages(input: { channelId: string; cursor?: string; pageLimit: number }): Promise<{
    readonly messages: readonly SlackKnowledgeMessage[];
    readonly nextCursor?: string;
  }> {
    // Bounded batch, not an all-or-nothing read: unlike listChannels/listMembers (where an
    // incomplete answer would be actively wrong), history is consumed through a durable
    // per-channel checkpoint (`syncChannel` in sync.ts). Stopping early after `maxPages`/
    // `maxItems` and returning what was gathered lets that checkpoint advance so the next sync
    // run resumes from where this one stopped, rather than the whole channel wedging forever on
    // `PaginationBoundError` for having more backlog than one run can fetch (a channel with a
    // large history would otherwise re-request the same unbounded range and fail every 15
    // minutes indefinitely).
    const bounds = { maxPages: 25, maxItems: 5000 };
    const raw: SlackHistoryMessage[] = [];
    let pageCursor: string | undefined;
    for (let page = 0; page < bounds.maxPages && raw.length < bounds.maxItems; page += 1) {
      const body = await this.call<{
        messages: SlackHistoryMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>("conversations.history", {
        channel: input.channelId,
        limit: "200",
        ...(input.cursor === undefined ? {} : { oldest: input.cursor }),
        ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
      });
      raw.push(...body.messages);
      const nextSlackCursor = body.has_more ? body.response_metadata?.next_cursor : undefined;
      if (nextSlackCursor === undefined) break;
      pageCursor = nextSlackCursor;
    }

    const messages = raw
      .filter((message): message is SlackHistoryMessage & { user: string; text: string } =>
        Boolean(message.user && message.text !== undefined && message.subtype === undefined)
      )
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .slice(0, input.pageLimit)
      .map(
        (message): SlackKnowledgeMessage => ({
          channelId: input.channelId,
          ts: message.ts,
          userExternalId: message.user,
          text: message.text,
          ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
          ...(message.edited?.ts ? { editedTs: message.edited.ts } : {}),
        })
      );

    return { messages };
  }

  private async call<T>(method: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}/${method}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
      },
    });
    const body = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!body.ok) throw new SlackApiError(body.error ?? "unknown_error");
    return body;
  }
}

function channelKind(channel: SlackConversationsListChannel): SlackChannelKind {
  if (channel.is_im) return "dm";
  if (channel.is_mpim) return "group_dm";
  if (channel.is_private) return "private";
  return "public";
}
