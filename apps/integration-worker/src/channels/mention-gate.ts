import type { SlackEventEnvelope } from "@tulipfarm/integrations";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";

/** Narrow raw Slack fields used before adapter normalization. */
interface MentionGateEvent {
  type?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
}

export interface MentionGateDeps {
  businessId: string;
  provider: string;
  mentionedThreads: ChannelMentionedThreadStore;
}

export type MentionGateResult =
  | { outcome: "pass"; envelope: SlackEventEnvelope }
  | { outcome: "drop"; reason: string };

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** DMs and app mentions pass; channel replies pass only in already-mentioned threads. */
export async function applyMentionGate(
  envelope: SlackEventEnvelope,
  deps: MentionGateDeps
): Promise<MentionGateResult> {
  if (envelope.type !== "event_callback") {
    return { outcome: "drop", reason: "unsupported_envelope_type" };
  }
  const event = envelope.event as MentionGateEvent | undefined;
  if (event === undefined) return { outcome: "drop", reason: "missing_event" };

  if (event.bot_id !== undefined || event.subtype === "bot_message") {
    return { outcome: "drop", reason: "bot_message" };
  }

  const channelId = requiredString(event.channel);
  if (channelId === undefined) return { outcome: "drop", reason: "missing_channel" };

  if (event.channel_type === "im") {
    return { outcome: "pass", envelope };
  }

  if (event.type === "app_mention") {
    const ts = requiredString(event.ts);
    if (ts === undefined) return { outcome: "drop", reason: "missing_ts" };
    const threadId = requiredString(event.thread_ts) ?? ts;
    await deps.mentionedThreads.mark({
      businessId: deps.businessId,
      provider: deps.provider,
      channelId,
      threadId,
    });
    return {
      outcome: "pass",
      envelope: { ...envelope, event: { ...event, type: "message" } },
    };
  }

  if (event.type === "message") {
    const threadId = requiredString(event.thread_ts);
    if (threadId === undefined) return { outcome: "drop", reason: "unmentioned_top_level" };
    const mentioned = await deps.mentionedThreads.isMentioned({
      businessId: deps.businessId,
      provider: deps.provider,
      channelId,
      threadId,
    });
    if (!mentioned) return { outcome: "drop", reason: "unmentioned_thread" };
    return { outcome: "pass", envelope };
  }

  return { outcome: "drop", reason: "unsupported_event_type" };
}
