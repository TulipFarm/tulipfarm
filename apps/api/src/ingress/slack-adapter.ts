/**
 * Pure classifier for Slack Events API payloads → ingress decisions. All Slack-protocol rules
 * live here (bot-loop prevention, mention/DM/thread-following chat rules, chat-vs-event split)
 * so the worker orchestration stays protocol-agnostic and the matrix is unit-testable without
 * any I/O — thread-mapping existence is injected as a callback.
 */

/** A chat-kind message to inject into a TulipFarm conversation. */
export interface ChatIngressMessage {
  teamId: string;
  channel: string;
  /** Thread root this message belongs to (thread_ts ?? ts) — the conversation mapping key. */
  threadTs: string;
  /** True when the reply should be posted with thread_ts (channels); DMs reply unthreaded. */
  isDm: boolean;
  slackUserId: string;
  /** Message text with any leading <@bot> mention stripped. */
  text: string;
}

export type IngressDecision =
  | { kind: "ignore"; reason: string }
  | { kind: "chat"; msg: ChatIngressMessage }
  | { kind: "event"; eventType: string; payload: Record<string, unknown> };

interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
  [key: string]: unknown;
}

export interface SlackClassifyContext {
  /** The bot's own user id from auth.test; null when unavailable (mention/DM rules still work). */
  botUserId: string | null;
  /** Whether a chat mapping exists for {team}/{channel}/{threadTs} (thread-following rule). */
  hasThreadMapping: (teamId: string, channel: string, threadTs: string) => Promise<boolean>;
}

function mentionsBot(text: string | undefined, botUserId: string | null): boolean {
  return botUserId !== null && typeof text === "string" && text.includes(`<@${botUserId}>`);
}

/** Strip every <@bot> mention token (Slack renders them as `<@U123>` in the raw text). */
export function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text.trim();
  return text
    .replaceAll(`<@${botUserId}>`, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function classifySlackPayload(
  body: Record<string, unknown>,
  ctx: SlackClassifyContext
): Promise<IngressDecision> {
  if (body.type !== "event_callback") return { kind: "ignore", reason: "not an event_callback" };
  const event = (body.event ?? {}) as SlackEvent;
  const teamId = String(body.team_id ?? "");

  // Bot-loop prevention: never react to the bot's own output or to other bots. Subtyped
  // messages (edits, deletes, joins rendered as messages, bot_message) are noise for chat.
  if (event.bot_id) return { kind: "ignore", reason: "bot message" };
  if (ctx.botUserId && event.user === ctx.botUserId)
    return { kind: "ignore", reason: "own message" };

  if (event.type === "app_mention") {
    return chatDecision(event, teamId, false, ctx);
  }

  if (event.type === "message") {
    if (event.subtype) return { kind: "ignore", reason: `message subtype ${event.subtype}` };
    if (event.channel_type === "im") return chatDecision(event, teamId, true, ctx);
    // A channel message containing the mention arrives ALONGSIDE a paired app_mention event
    // (different event_id, so delivery dedup can't collapse them) — the app_mention wins.
    if (mentionsBot(event.text, ctx.botUserId)) {
      return { kind: "ignore", reason: "mention handled by paired app_mention" };
    }
    // Thread-following: reply in a thread the bot is already part of — previously mentioned
    // (mapping exists) or rooted on a bot message (parent_user_id) — without a fresh mention.
    if (event.thread_ts) {
      const channel = String(event.channel ?? "");
      if (ctx.botUserId && event.parent_user_id === ctx.botUserId) {
        return chatDecision(event, teamId, false, ctx);
      }
      if (await ctx.hasThreadMapping(teamId, channel, event.thread_ts)) {
        return chatDecision(event, teamId, false, ctx);
      }
    }
    // Untargeted channel chatter never becomes an integration event (flood control).
    return { kind: "ignore", reason: "channel message not addressed to the bot" };
  }

  // Everything else the workspace subscribed to (member_joined_channel, reaction_added, …)
  // is a webhook-kind event: persisted + raised as an integration.event domain event.
  return {
    kind: "event",
    eventType: String(event.type ?? "unknown"),
    payload: event as Record<string, unknown>,
  };
}

function chatDecision(
  event: SlackEvent,
  teamId: string,
  isDm: boolean,
  ctx: SlackClassifyContext
): IngressDecision {
  const channel = String(event.channel ?? "");
  const ts = String(event.ts ?? "");
  const slackUserId = String(event.user ?? "");
  if (!channel || !ts || !slackUserId) return { kind: "ignore", reason: "malformed chat event" };
  return {
    kind: "chat",
    msg: {
      teamId,
      channel,
      threadTs: String(event.thread_ts ?? ts),
      isDm,
      slackUserId,
      text: stripBotMention(String(event.text ?? ""), ctx.botUserId),
    },
  };
}
