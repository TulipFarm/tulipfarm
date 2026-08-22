import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/** Slack send is not blind-retry-safe; ambiguous sends reconcile against channel history. */

export const SLACK_ADAPTER_REF = "integration:slack";

export const SLACK_TOOL_IDS = {
  listChannels: "slack.channel.list",
  sendMessage: "slack.message.send",
} as const;

export type SlackToolId = (typeof SLACK_TOOL_IDS)[keyof typeof SLACK_TOOL_IDS];

/** Reconciliation lookups the adapter implements for each mutating Tool. */
export const SLACK_RECONCILIATION_OPERATIONS = {
  sendMessage: "slack.message.send.lookup",
} as const;

const TOOL_VERSION = "1.0.0";
const SLACK_DESTINATION = "slack";
const MESSAGE_DATA_CLASSES = ["source_content"];
const CHANNEL_DIRECTORY_DATA_CLASSES = ["directory"];

const listChannelsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const listChannelsOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
} as const;

const sendMessageInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "text"],
  properties: {
    channel: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description:
        "Channel name (with or without a leading '#') or raw Slack channel ID. Must be a " +
        "channel the bot has joined.",
    },
    text: { type: "string", minLength: 1, maxLength: 4000 },
  },
} as const;

const sendMessageOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["channelId", "ts", "threadId"],
  properties: {
    channelId: { type: "string" },
    ts: { type: "string" },
    threadId: { type: "string" },
  },
} as const;

/**
 * Authored definitions are content-addressed. Deriving the digest from the spec keeps these
 * first-party contracts publishable without hand-maintained hashes that would silently drift.
 */
function publish(spec: ToolContractSpec, id: string, slug: string): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}

const sendMessage = publish(
  {
    toolId: SLACK_TOOL_IDS.sendMessage,
    toolVersion: TOOL_VERSION,
    action: SLACK_TOOL_IDS.sendMessage,
    inputSchema: sendMessageInputSchema,
    outputSchema: sendMessageOutputSchema,
    riskClass: "medium",
    mutating: true,
    dataClasses: MESSAGE_DATA_CLASSES,
    allowedDestinations: [SLACK_DESTINATION],
    idempotency: { strategy: "reconcile" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: true,
    compensation: {
      operation: "slack.message.delete",
      reconciliation: SLACK_RECONCILIATION_OPERATIONS.sendMessage,
    },
    adapter: { kind: "integration", ref: SLACK_ADAPTER_REF },
  },
  "aaaaaaaa-0004-4000-8000-000000000001",
  "slack-message-send"
);

const listChannels = publish(
  {
    toolId: SLACK_TOOL_IDS.listChannels,
    toolVersion: TOOL_VERSION,
    action: SLACK_TOOL_IDS.listChannels,
    inputSchema: listChannelsInputSchema,
    outputSchema: listChannelsOutputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses: CHANNEL_DIRECTORY_DATA_CLASSES,
    allowedDestinations: [SLACK_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: SLACK_ADAPTER_REF },
  },
  "aaaaaaaa-0004-4000-8000-000000000002",
  "slack-channel-list"
);

export const SLACK_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [listChannels, sendMessage];

export const SLACK_TOOL_DECLARATIONS = [
  {
    toolId: SLACK_TOOL_IDS.listChannels,
    name: "slack_channel_list",
    description:
      "List the Slack channels the bot has joined. Use this before send_slack_message when the " +
      "channel is uncertain, then send with the returned stable channel ID.",
    inputSchema: listChannelsInputSchema,
  },
  {
    toolId: SLACK_TOOL_IDS.sendMessage,
    name: "send_slack_message",
    description:
      "Send a message to a Slack channel the bot has joined. Accepts a channel name (with or " +
      "without a leading '#') or a raw channel ID. If the channel is uncertain, first call " +
      "slack_channel_list and then send with its stable channel ID. A human reply in the " +
      "resulting thread continues this same conversation. To notify a specific person, write " +
      "'@' followed by their Slack name or first name (e.g. 'hi @mohit') — this is converted " +
      "into a real, clickable, notifying Slack mention before sending. Writing the name with no " +
      "'@' sends it as plain text and does not notify or tag anyone.",
    inputSchema: sendMessageInputSchema,
  },
] as const;
