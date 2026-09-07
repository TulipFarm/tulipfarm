import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";

export const SLACK_ADAPTER_REF = "integration:slack";

export const SLACK_TOOL_IDS = {
  listChannels: "slack.channel.list",
  getConversation: "slack.conversation.get",
  sendMessage: "slack.message.send",
  updateMessage: "slack.message.update",
  deleteMessage: "slack.message.delete",
  acknowledge: "slack.message.acknowledge",
  removeReaction: "slack.reaction.remove",
  uploadFile: "slack.file.upload",
  getFileInfo: "slack.file.info",
  manageBookmark: "slack.bookmark.manage",
  managePin: "slack.pin.manage",
  lookupUser: "slack.user.lookup",
} as const;

export type SlackToolId = (typeof SLACK_TOOL_IDS)[keyof typeof SLACK_TOOL_IDS];

export const SLACK_RECONCILIATION_OPERATIONS = {
  sendMessage: "slack.message.send.lookup",
  updateMessage: "slack.message.update.lookup",
  deleteMessage: "slack.message.delete.lookup",
  uploadFile: "slack.file.upload.lookup",
  manageBookmark: "slack.bookmark.manage.lookup",
} as const;

const VERSION = "1.0.0";
const DESTINATION = "slack";
const MESSAGE_DATA = ["source_content"];
const DIRECTORY_DATA = ["directory"];
const FILE_DATA = ["file_content"];

const channel = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  description: "A joined Slack conversation name or ID.",
} as const;
const timestamp = { type: "string", minLength: 1, maxLength: 32 } as const;
const emptyInput = { type: "object", additionalProperties: false, properties: {} } as const;
const okOutput = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
} as const;

const listChannelsOutput = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const getConversationInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel"],
  properties: {
    channel,
    threadTs: timestamp,
    cursor: { type: "string", minLength: 1, maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
  },
} as const;
const messageItem = {
  type: "object",
  additionalProperties: false,
  required: ["ts", "text"],
  properties: {
    ts: timestamp,
    text: { type: "string", maxLength: 40_000 },
    userId: { type: "string" },
    threadTs: timestamp,
  },
} as const;
const getConversationOutput = {
  type: "object",
  additionalProperties: false,
  required: ["conversation", "messages"],
  properties: {
    conversation: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        topic: { type: "string" },
        purpose: { type: "string" },
      },
    },
    messages: { type: "array", maxItems: 200, items: messageItem },
    nextCursor: { type: "string" },
  },
} as const;

const sendInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "text"],
  properties: {
    channel,
    text: { type: "string", minLength: 1, maxLength: 4_000 },
  },
} as const;
const messageOutput = {
  type: "object",
  additionalProperties: false,
  required: ["channelId", "ts", "threadId"],
  properties: {
    channelId: { type: "string" },
    ts: timestamp,
    threadId: timestamp,
  },
} as const;
const updateInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "ts", "text"],
  properties: { channel, ts: timestamp, text: sendInput.properties.text },
} as const;
const deleteInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "ts"],
  properties: { channel, ts: timestamp },
} as const;

const acknowledgeInput = {
  type: "object",
  additionalProperties: false,
  required: ["emoji"],
  properties: {
    emoji: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Emoji short name without colons.",
    },
  },
} as const;
const acknowledgeOutput = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "emoji"],
  properties: { ok: { type: "boolean" }, emoji: { type: "string" } },
} as const;
const removeReactionInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "timestamp", "emoji"],
  properties: {
    channel,
    timestamp,
    emoji: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const uploadFileInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "fileId"],
  properties: {
    channel,
    fileId: { type: "string", minLength: 1, maxLength: 128 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    initialComment: { type: "string", minLength: 1, maxLength: 4_000 },
    threadTs: timestamp,
  },
} as const;
const fileInfoInput = {
  type: "object",
  additionalProperties: false,
  required: ["channel", "fileId"],
  properties: { channel, fileId: { type: "string", minLength: 1, maxLength: 128 } },
} as const;
const fileOutput = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "mimetype", "size"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    mimetype: { type: "string" },
    size: { type: "integer", minimum: 0 },
    created: { type: "integer", minimum: 0 },
  },
} as const;

const bookmarkInput = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "channel"],
  properties: {
    operation: { type: "string", enum: ["list", "add", "edit", "remove"] },
    channel,
    bookmarkId: { type: "string", minLength: 1, maxLength: 128 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    link: { type: "string", minLength: 1, maxLength: 2_048 },
    emoji: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;
const bookmarkItem = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "link"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    link: { type: "string" },
    emoji: { type: "string" },
  },
} as const;
const bookmarkOutput = {
  type: "object",
  additionalProperties: false,
  required: ["bookmarks"],
  properties: { bookmarks: { type: "array", maxItems: 100, items: bookmarkItem } },
} as const;

const pinInput = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "channel"],
  properties: {
    operation: { type: "string", enum: ["list", "add", "remove"] },
    channel,
    timestamp,
  },
} as const;
const pinItem = {
  type: "object",
  additionalProperties: false,
  required: ["timestamp"],
  properties: {
    timestamp,
    text: { type: "string", maxLength: 40_000 },
  },
} as const;
const pinOutput = {
  type: "object",
  additionalProperties: false,
  required: ["pins"],
  properties: { pins: { type: "array", maxItems: 100, items: pinItem } },
} as const;

const userLookupInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1, maxLength: 64 },
    query: { type: "string", minLength: 1, maxLength: 100 },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
  },
  anyOf: [{ required: ["userId"] }, { required: ["query"] }],
} as const;
const userItem = {
  type: "object",
  additionalProperties: false,
  required: ["id", "displayName", "isBotOrApp", "deleted"],
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    isBotOrApp: { type: "boolean" },
    deleted: { type: "boolean" },
  },
} as const;
const userLookupOutput = {
  type: "object",
  additionalProperties: false,
  required: ["users"],
  properties: { users: { type: "array", maxItems: 20, items: userItem } },
} as const;

function publish(
  id: string,
  slug: string,
  spec: Omit<ToolContractSpec, "toolVersion" | "allowedDestinations" | "adapter">
): ToolContractDefinition {
  const complete: ToolContractSpec = {
    ...spec,
    toolVersion: VERSION,
    allowedDestinations: [DESTINATION],
    adapter: { kind: "integration", ref: SLACK_ADAPTER_REF },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(complete),
    },
    spec: complete,
  };
}

const read = (
  id: string,
  slug: string,
  toolId: SlackToolId,
  inputSchema: ToolContractSpec["inputSchema"],
  outputSchema: ToolContractSpec["outputSchema"],
  dataClasses: string[] = MESSAGE_DATA
) =>
  publish(id, slug, {
    toolId,
    action: toolId,
    inputSchema,
    outputSchema,
    riskClass: "low",
    mutating: false,
    dataClasses,
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
  });

const mutation = (
  id: string,
  slug: string,
  toolId: SlackToolId,
  inputSchema: ToolContractSpec["inputSchema"],
  outputSchema: ToolContractSpec["outputSchema"],
  riskClass: "low" | "medium" | "high",
  strategy: "provider" | "reconcile",
  reconciliation?: string,
  dataClasses: string[] = MESSAGE_DATA,
  compensationOperation: string = toolId
) =>
  publish(id, slug, {
    toolId,
    action: toolId,
    inputSchema,
    outputSchema,
    riskClass,
    mutating: true,
    dataClasses,
    idempotency: { strategy },
    timeout: { wallClockMs: 30_000 },
    retry: { maxAttempts: strategy === "provider" ? 3 : 1, safeToRetry: strategy === "provider" },
    dryRun: false,
    ...(reconciliation === undefined
      ? {}
      : { compensation: { operation: compensationOperation, reconciliation } }),
  });

const listChannels = read(
  "aaaaaaaa-0004-4000-8000-000000000002",
  "slack-channel-list",
  SLACK_TOOL_IDS.listChannels,
  emptyInput,
  listChannelsOutput,
  DIRECTORY_DATA
);
const getConversation = read(
  "aaaaaaaa-0004-4000-8000-000000000004",
  "slack-conversation-get",
  SLACK_TOOL_IDS.getConversation,
  getConversationInput,
  getConversationOutput
);
const sendMessage = mutation(
  "aaaaaaaa-0004-4000-8000-000000000001",
  "slack-message-send",
  SLACK_TOOL_IDS.sendMessage,
  sendInput,
  messageOutput,
  "medium",
  "reconcile",
  SLACK_RECONCILIATION_OPERATIONS.sendMessage,
  MESSAGE_DATA,
  SLACK_TOOL_IDS.deleteMessage
);
const updateMessage = mutation(
  "aaaaaaaa-0004-4000-8000-000000000005",
  "slack-message-update",
  SLACK_TOOL_IDS.updateMessage,
  updateInput,
  messageOutput,
  "medium",
  "reconcile",
  SLACK_RECONCILIATION_OPERATIONS.updateMessage
);
const deleteMessage = mutation(
  "aaaaaaaa-0004-4000-8000-000000000006",
  "slack-message-delete",
  SLACK_TOOL_IDS.deleteMessage,
  deleteInput,
  okOutput,
  "high",
  "reconcile",
  SLACK_RECONCILIATION_OPERATIONS.deleteMessage
);
const acknowledge = mutation(
  "aaaaaaaa-0004-4000-8000-000000000003",
  "slack-message-acknowledge",
  SLACK_TOOL_IDS.acknowledge,
  acknowledgeInput,
  acknowledgeOutput,
  "low",
  "provider"
);
const removeReaction = mutation(
  "aaaaaaaa-0004-4000-8000-000000000007",
  "slack-reaction-remove",
  SLACK_TOOL_IDS.removeReaction,
  removeReactionInput,
  acknowledgeOutput,
  "medium",
  "provider"
);
const uploadFile = mutation(
  "aaaaaaaa-0004-4000-8000-000000000008",
  "slack-file-upload",
  SLACK_TOOL_IDS.uploadFile,
  uploadFileInput,
  fileOutput,
  "high",
  "reconcile",
  SLACK_RECONCILIATION_OPERATIONS.uploadFile,
  FILE_DATA
);
const getFileInfo = read(
  "aaaaaaaa-0004-4000-8000-000000000009",
  "slack-file-info",
  SLACK_TOOL_IDS.getFileInfo,
  fileInfoInput,
  fileOutput,
  FILE_DATA
);
const manageBookmark = mutation(
  "aaaaaaaa-0004-4000-8000-000000000010",
  "slack-bookmark-manage",
  SLACK_TOOL_IDS.manageBookmark,
  bookmarkInput,
  bookmarkOutput,
  "high",
  "reconcile",
  SLACK_RECONCILIATION_OPERATIONS.manageBookmark
);
const managePin = mutation(
  "aaaaaaaa-0004-4000-8000-000000000011",
  "slack-pin-manage",
  SLACK_TOOL_IDS.managePin,
  pinInput,
  pinOutput,
  "high",
  "provider"
);
const lookupUser = read(
  "aaaaaaaa-0004-4000-8000-000000000012",
  "slack-user-lookup",
  SLACK_TOOL_IDS.lookupUser,
  userLookupInput,
  userLookupOutput,
  DIRECTORY_DATA
);

export const SLACK_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [
  listChannels,
  getConversation,
  sendMessage,
  updateMessage,
  deleteMessage,
  acknowledge,
  removeReaction,
  uploadFile,
  getFileInfo,
  manageBookmark,
  managePin,
  lookupUser,
];

const declarations = [
  [listChannels, "slack_channel_list", "List up to 100 Slack conversations the bot has joined."],
  [
    getConversation,
    "slack_conversation_get",
    "Read up to 200 messages from one Slack conversation the bot has joined.",
  ],
  [
    sendMessage,
    "send_slack_message",
    "Send a message to a Slack conversation the bot has joined. Use @name for a real mention.",
  ],
  [updateMessage, "slack_message_update", "Update a Slack message created by this Integration."],
  [deleteMessage, "slack_message_delete", "Delete a Slack message created by this Integration."],
  [
    acknowledge,
    "slack_acknowledge",
    "React to the Slack message that started this Run instead of replying.",
  ],
  [
    removeReaction,
    "slack_reaction_remove",
    "Remove a reaction previously created by this Integration.",
  ],
  [uploadFile, "slack_file_upload", "Upload a governed TulipFarm File to a joined conversation."],
  [getFileInfo, "slack_file_info", "Read allowlisted metadata for one Slack File."],
  [
    manageBookmark,
    "slack_bookmark_manage",
    "List, add, edit, or remove bookmarks in one joined conversation.",
  ],
  [managePin, "slack_pin_manage", "List, add, or remove pins in one joined conversation."],
  [
    lookupUser,
    "slack_user_lookup",
    "Look up Slack users by ID or bounded name prefix. Returns only allowlisted directory fields.",
  ],
] as const;

export const SLACK_TOOL_DECLARATIONS = declarations.map(([contract, name, description]) => ({
  toolId: contract.spec.toolId,
  toolVersion: contract.spec.toolVersion,
  name,
  description,
  inputSchema: contract.spec.inputSchema,
}));
