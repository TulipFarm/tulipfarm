import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

/** Slack send is not blind-retry-safe; ambiguous sends reconcile against channel history. */

export const SLACK_ADAPTER_REF = "integration:slack";

export const SLACK_TOOL_IDS = {
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

export const SLACK_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [sendMessage];
