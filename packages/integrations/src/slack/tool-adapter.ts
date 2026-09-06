import type { ChannelRunDeliveryStore } from "@tulipfarm/storage";
import type { ToolAdapter, ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { AdapterDispatchError } from "@tulipfarm/tool-broker";
import {
  classifyHttpFailure,
  collectPages,
  type IntegrationHttpPort,
  PaginationBoundError,
} from "../http";
import { SLACK_TOOL_IDS } from "./contracts";
import { normalizeEmojiName, SlackEmojiDirectory, type SlackEmojiDirectoryPort } from "./emoji";
import { encodeMentionsInText, encodeRawIdsInText, type SlackUserLookupPort } from "./mentions";

/**
 * Dispatches `slack.message.send`; resolves names to channel ids and uses `client_msg_id` for
 * Slack-native idempotency.
 */
export interface SlackToolAdapterDeps {
  readonly http: IntegrationHttpPort;
  /**
   * When the Run that's calling this Tool was itself started from a Slack thread, replies to the
   * same channel default to that thread instead of posting a new root message.
   */
  readonly channelRunDelivery?: Pick<ChannelRunDeliveryStore, "find"> & {
    /** Widened return: the adapter needs the write to have happened, not the row it produced. */
    markAcknowledged(businessId: string, runId: string, emoji: string): Promise<unknown>;
  };
}

interface SlackApiChannel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly is_member?: unknown;
}

interface SlackApiUser {
  readonly id: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly profile?: {
    readonly display_name?: string;
    readonly real_name?: string;
  };
}

function candidateNames(user: SlackApiUser): readonly string[] {
  return [user.name, user.profile?.display_name, user.profile?.real_name, user.real_name].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
}

function isChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/.test(value);
}

function normalizeChannelName(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

function args(intent: ToolAdapterRequest["intent"]): { channel: string; text: string } {
  const raw = intent.arguments as Record<string, unknown>;
  const channel = raw.channel;
  const text = raw.text;
  if (typeof channel !== "string" || channel.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return { channel, text };
}

function acknowledgeArgs(intent: ToolAdapterRequest["intent"]): { emoji: string } {
  const emoji = (intent.arguments as Record<string, unknown>).emoji;
  if (typeof emoji !== "string" || emoji.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return { emoji };
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export class SlackToolAdapter implements ToolAdapter {
  readonly kind = "integration" as const;

  private readonly emojiDirectories = new Map<string, SlackEmojiDirectory>();

  constructor(private readonly deps: SlackToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    if (
      request.intent.toolId !== SLACK_TOOL_IDS.listChannels &&
      request.intent.toolId !== SLACK_TOOL_IDS.sendMessage &&
      request.intent.toolId !== SLACK_TOOL_IDS.acknowledge
    ) {
      throw new AdapterDispatchError("before_dispatch", "unsupported_tool", false);
    }
    if (credential === undefined) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    if (request.intent.toolId === SLACK_TOOL_IDS.listChannels) {
      return { channels: await this.listChannels(credential) };
    }
    if (request.intent.toolId === SLACK_TOOL_IDS.acknowledge) {
      return this.acknowledge(request, credential);
    }

    const { channel, text } = args(request.intent);
    const channelId = isChannelId(channel)
      ? channel
      : await this.resolveChannelId(normalizeChannelName(channel), credential);
    const encodedText = await encodeMentionsInText(
      encodeRawIdsInText(text),
      this.userLookup(credential)
    );
    const threadTs = await this.originatingThreadTs(request, channelId, credential);

    const response = await this.deps.http.send(
      {
        method: "POST",
        path: "/chat.postMessage",
        body: {
          channel: channelId,
          text: encodedText,
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
          client_msg_id: request.idempotencyKey,
        },
      },
      credential
    );
    const body = asRecord(response.body);
    const failure = classifyHttpFailure(response, true);
    if (failure !== null || body.ok !== true) {
      const code =
        typeof body.error === "string" ? body.error : (failure?.code ?? "provider_error");
      const retryable = failure?.retryable ?? false;
      const phase = failure?.phase ?? "before_dispatch";
      throw new AdapterDispatchError(phase, code, retryable);
    }

    const ts = body.ts;
    if (typeof ts !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    return { channelId, ts, threadId: ts };
  }

  /**
   * Reacts to the very message this Run was started from, in place of a reply.
   *
   * The target is not an argument: an Agent that could name any message could react anywhere in
   * the workspace, so the message is read from the delivery row that started the Run. A Run with
   * no such row has nothing to react to and fails rather than guessing.
   */
  private async acknowledge(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const store = this.deps.channelRunDelivery;
    if (store === undefined) {
      throw new AdapterDispatchError("before_dispatch", "acknowledge_unavailable", false);
    }
    const { emoji } = acknowledgeArgs(request.intent);
    const delivery = await store
      .find(request.intent.businessId, request.intent.runId)
      .catch(() => null);
    if (delivery === null || delivery.provider !== "slack") {
      throw new AdapterDispatchError("before_dispatch", "acknowledge_target_unknown", false);
    }
    const timestamp = delivery.sourceMessageTs;
    if (timestamp === undefined) {
      throw new AdapterDispatchError("before_dispatch", "acknowledge_target_unknown", false);
    }

    const resolution = await this.emojiDirectory(credential).resolve(emoji);
    // An unresolved name is still sent: the directory can be stale or unreadable, and Slack is the
    // real authority on what it will accept. Its `invalid_name` carries the candidates back.
    const name = resolution.outcome === "resolved" ? resolution.name : normalizeEmojiName(emoji);

    const response = await this.deps.http.send(
      {
        method: "POST",
        path: "/reactions.add",
        body: { channel: delivery.destination, timestamp, name },
      },
      credential
    );
    const body = asRecord(response.body);
    const failure = classifyHttpFailure(response, true);
    const error = typeof body.error === "string" ? body.error : undefined;
    // Slack refuses a repeat rather than duplicating it, which is exactly the convergence a
    // provider-idempotent retry needs.
    if (body.ok !== true && error !== "already_reacted") {
      if (error === "invalid_name" || error === "no_reaction") {
        const candidates =
          resolution.outcome === "unknown" && resolution.candidates.length > 0
            ? `:${resolution.candidates.join(",")}`
            : "";
        throw new AdapterDispatchError("before_dispatch", `emoji_not_found${candidates}`, false);
      }
      const code = error ?? failure?.code ?? "provider_error";
      throw new AdapterDispatchError(
        failure?.phase ?? "before_dispatch",
        code,
        error === undefined ? (failure?.retryable ?? false) : false
      );
    }

    await store.markAcknowledged(request.intent.businessId, request.intent.runId, name);
    return { ok: true, emoji: name };
  }

  /**
   * One directory per credential: the cache is worth nothing if a new instance is built per call,
   * and two workspaces must never share one.
   */
  private emojiDirectory(credential: string): SlackEmojiDirectory {
    const existing = this.emojiDirectories.get(credential);
    if (existing !== undefined) return existing;
    const port: SlackEmojiDirectoryPort = {
      load: async () => {
        const response = await this.deps.http.send(
          { method: "GET", path: "/emoji.list" },
          credential
        );
        const body = asRecord(response.body);
        if (body.ok !== true)
          throw new AdapterDispatchError("before_dispatch", "emoji_list_failed", false);
        const emoji = asRecord(body.emoji);
        const names: Record<string, string> = {};
        for (const [key, value] of Object.entries(emoji)) {
          if (typeof value === "string") names[key] = value;
        }
        return names;
      },
    };
    const directory = new SlackEmojiDirectory(port);
    this.emojiDirectories.set(credential, directory);
    return directory;
  }

  /**
   * Best-effort: only threads a reply when this Run started from a Slack thread in the same
   * channel the Tool is posting to. A lookup failure or channel mismatch falls back to a fresh
   * root message rather than blocking the send.
   */
  private async originatingThreadTs(
    request: ToolAdapterRequest,
    channelId: string,
    credential: string
  ): Promise<string | undefined> {
    if (this.deps.channelRunDelivery === undefined) return undefined;
    const delivery = await this.deps.channelRunDelivery
      .find(request.intent.businessId, request.intent.runId)
      .catch(() => null);
    if (delivery === null || delivery.provider !== "slack" || delivery.threadId === undefined) {
      return undefined;
    }
    const destinationId = isChannelId(delivery.destination)
      ? delivery.destination
      : await this.resolveChannelId(normalizeChannelName(delivery.destination), credential).catch(
          () => undefined
        );
    return destinationId === channelId ? delivery.threadId : undefined;
  }

  /** Memoized best-effort user lookup; first-name fallback only when exactly one match exists. */
  private userLookup(credential: string): SlackUserLookupPort {
    let directory:
      | Promise<{ exact: Map<string, string>; firstName: Map<string, string | null> }>
      | undefined;
    const load = async () => {
      const exact = new Map<string, string>();
      const firstName = new Map<string, string | null>();
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const response = await this.deps.http.send(
          {
            method: "GET",
            path: "/users.list",
            query: { limit: "200", ...(cursor === undefined ? {} : { cursor }) },
          },
          credential
        );
        const body = asRecord(response.body);
        if (body.ok !== true) break;
        const members = Array.isArray(body.members) ? (body.members as SlackApiUser[]) : [];
        for (const member of members) {
          for (const name of candidateNames(member)) {
            const lower = name.toLowerCase();
            if (!exact.has(lower)) exact.set(lower, member.id);

            const first = lower.split(/\s+/)[0];
            if (first.length > 0 && first !== lower) {
              const existing = firstName.get(first);
              if (existing === undefined) firstName.set(first, member.id);
              else if (existing !== member.id) firstName.set(first, null);
            }
          }
        }
        const metadata = asRecord(body.response_metadata);
        const nextCursor = metadata.next_cursor;
        if (typeof nextCursor !== "string" || nextCursor.length === 0) break;
        cursor = nextCursor;
      }
      return { exact, firstName };
    };

    return {
      async resolveUserId(name: string): Promise<string | undefined> {
        directory ??= load().catch(() => ({ exact: new Map(), firstName: new Map() }));
        const { exact, firstName } = await directory;
        const lower = name.toLowerCase();
        return exact.get(lower) ?? firstName.get(lower) ?? undefined;
      },
    };
  }

  private async resolveChannelId(name: string, credential: string): Promise<string> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.deps.http.send(
        {
          method: "GET",
          path: "/conversations.list",
          query: {
            types: "public_channel,private_channel",
            limit: "200",
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        credential
      );
      const body = asRecord(response.body);
      if (body.ok !== true) {
        throw new AdapterDispatchError("before_dispatch", "channel_lookup_failed", false);
      }
      const channels = Array.isArray(body.channels) ? (body.channels as SlackApiChannel[]) : [];
      const match = channels.find(
        (channel) => channel.name === name && typeof channel.id === "string"
      );
      if (match !== undefined && typeof match.id === "string") return match.id;

      const metadata = asRecord(body.response_metadata);
      const nextCursor = metadata.next_cursor;
      if (typeof nextCursor !== "string" || nextCursor.length === 0) break;
      cursor = nextCursor;
    }
    throw new AdapterDispatchError("before_dispatch", "channel_not_found", false);
  }

  private async listChannels(credential: string): Promise<{ id: string; name: string }[]> {
    try {
      const channels = await collectPages<SlackApiChannel>(
        async (cursor) => {
          const response = await this.deps.http.send(
            {
              method: "GET",
              path: "/conversations.list",
              query: {
                types: "public_channel,private_channel",
                exclude_archived: "true",
                limit: "200",
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
            credential
          );
          const body = asRecord(response.body);
          const failure = classifyHttpFailure(response, false);
          if (failure !== null || body.ok !== true) {
            const code =
              typeof body.error === "string" ? body.error : (failure?.code ?? "provider_error");
            throw new AdapterDispatchError(
              failure?.phase ?? "before_dispatch",
              code,
              failure?.retryable ?? false
            );
          }
          const items = Array.isArray(body.channels) ? (body.channels as SlackApiChannel[]) : [];
          const metadata = asRecord(body.response_metadata);
          const nextCursor = metadata.next_cursor;
          return {
            items,
            ...(typeof nextCursor === "string" && nextCursor.length > 0 ? { nextCursor } : {}),
          };
        },
        { maxPages: 20, maxItems: 4_000 }
      );
      return channels.flatMap((channel) =>
        channel.is_member === true &&
        typeof channel.id === "string" &&
        channel.id.length > 0 &&
        typeof channel.name === "string" &&
        channel.name.length > 0
          ? [{ id: channel.id, name: channel.name }]
          : []
      );
    } catch (error) {
      if (error instanceof PaginationBoundError) {
        throw new AdapterDispatchError("before_dispatch", "pagination_bound_exceeded", false);
      }
      throw error;
    }
  }
}
