import type { ToolAdapter, ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { AdapterDispatchError } from "@tulipfarm/tool-broker";
import { classifyHttpFailure, type IntegrationHttpPort } from "../http";
import { SLACK_TOOL_IDS } from "./contracts";
import { encodeMentionsInText, type SlackUserLookupPort } from "./mentions";

/**
 * Dispatches `slack.message.send`; resolves names to channel ids and uses `client_msg_id` for
 * Slack-native idempotency.
 */
export interface SlackToolAdapterDeps {
  readonly http: IntegrationHttpPort;
}

interface SlackApiChannel {
  readonly id: string;
  readonly name: string;
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

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export class SlackToolAdapter implements ToolAdapter {
  constructor(private readonly deps: SlackToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    if (request.intent.toolId !== SLACK_TOOL_IDS.sendMessage) {
      throw new AdapterDispatchError("before_dispatch", "unsupported_tool", false);
    }
    if (credential === undefined) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    const { channel, text } = args(request.intent);
    const channelId = isChannelId(channel)
      ? channel
      : await this.resolveChannelId(normalizeChannelName(channel), credential);
    const encodedText = await encodeMentionsInText(text, this.userLookup(credential));

    const response = await this.deps.http.send(
      {
        method: "POST",
        path: "/chat.postMessage",
        body: { channel: channelId, text: encodedText, client_msg_id: request.idempotencyKey },
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
      const match = channels.find((c) => c.name === name);
      if (match !== undefined) return match.id;

      const metadata = asRecord(body.response_metadata);
      const nextCursor = metadata.next_cursor;
      if (typeof nextCursor !== "string" || nextCursor.length === 0) break;
      cursor = nextCursor;
    }
    throw new AdapterDispatchError("before_dispatch", "channel_not_found", false);
  }
}
