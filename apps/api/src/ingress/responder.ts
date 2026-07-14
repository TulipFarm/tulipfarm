import type { ToolRegistry } from "../tools/registry";
import type { SlackClient } from "./slack-client";

/** Actor id stamped on tool calls made by the ingress reply path (no human session). */
export const INGRESS_ACTOR = "integration-ingress";

type ResponderLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export interface SlackResponderDeps {
  toolRegistry?: ToolRegistry;
  /** Direct Web API fallback when no MCP send tool is installed or the tool call fails. */
  client: SlackClient;
  log: ResponderLogger;
}

export interface SlackReply {
  channel: string;
  text: string;
  /** Present for channel replies (threaded); omitted for DM roots. */
  threadTs?: string;
}

/**
 * Post a reply back to Slack. Prefers an installed integration-tier Slack send tool (same
 * detection contract as routine approval delivery) with args mapped from the tool's own input
 * schema — MCP packages disagree on arg names (channel vs channel_id, thread_ts optionality).
 * Any tool failure falls back to the direct chat.postMessage client. Never throws: the turn
 * result is already durable in the conversation, so a failed reply only logs.
 */
export async function postSlackReply(deps: SlackResponderDeps, reply: SlackReply): Promise<void> {
  const tool = deps.toolRegistry
    ?.getAll()
    .find(
      (t) => t.tier === "integration" && /slack/i.test(t.name) && /send|post|message/i.test(t.name)
    );

  if (tool) {
    try {
      const props = propertyNames(tool.inputSchema);
      const args: Record<string, unknown> = {};
      const channelKey = props.find((p) => /^channel(_id)?$/i.test(p));
      const textKey = props.find((p) => /^(text|message)$/i.test(p));
      const threadKey = props.find((p) => /^thread_ts$/i.test(p));
      if (channelKey && textKey && (reply.threadTs === undefined || threadKey)) {
        args[channelKey] = reply.channel;
        args[textKey] = reply.text;
        if (reply.threadTs && threadKey) args[threadKey] = reply.threadTs;
        const result = await tool.execute(args, { userId: INGRESS_ACTOR, autonomy: "full" });
        if (result.success) return;
        deps.log.warn(
          { tool: tool.name, error: result.error },
          "slack reply via MCP tool failed; falling back to direct postMessage"
        );
      }
    } catch (err) {
      deps.log.warn(
        { tool: tool.name, err },
        "slack reply via MCP tool threw; falling back to direct postMessage"
      );
    }
  }

  try {
    await deps.client.postMessage({
      channel: reply.channel,
      text: reply.text,
      threadTs: reply.threadTs,
    });
  } catch (err) {
    deps.log.error({ err, channel: reply.channel }, "slack reply delivery failed");
  }
}

function propertyNames(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}
