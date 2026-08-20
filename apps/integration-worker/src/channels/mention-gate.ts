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

/**
 * Slack `message` subtypes that still carry a human's chat text. Every other subtype
 * (`message_changed`, `message_deleted`, `channel_join`, …) describes metadata about a message
 * rather than one being sent, and reports the author under `event.message`, not `event.user` —
 * so gating such an event on the outer fields decides on data Slack never populated.
 */
const CHAT_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "me_message",
  "thread_broadcast",
]);

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The installed bot's own Slack user id, from the envelope's `authorizations`. Absent on older
 * or unusual deliveries; the caller then falls back to the `bot_id` check alone.
 */
function botUserId(envelope: SlackEventEnvelope): string | undefined {
  const authorizations = (envelope as { authorizations?: unknown }).authorizations;
  if (!Array.isArray(authorizations)) return undefined;
  for (const entry of authorizations) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { user_id?: unknown; is_bot?: unknown };
    if (record.is_bot === true) {
      const userId = requiredString(record.user_id);
      if (userId !== undefined) return userId;
    }
  }
  return undefined;
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

  const self = botUserId(envelope);
  if (self !== undefined && event.user === self) {
    return { outcome: "drop", reason: "self_message" };
  }

  if (
    event.type === "message" &&
    typeof event.subtype === "string" &&
    !CHAT_MESSAGE_SUBTYPES.has(event.subtype)
  ) {
    return { outcome: "drop", reason: "non_chat_subtype" };
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
