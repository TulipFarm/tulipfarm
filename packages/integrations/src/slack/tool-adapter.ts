import type { ChannelRunDeliveryStore } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterRequest,
  type ToolReconciliationAdapter,
  type ToolReconciliationOutcome,
  type ToolReconciliationRequest,
} from "@tulipfarm/tool-broker";
import {
  classifyHttpFailure,
  collectPages,
  type IntegrationHttpPort,
  PaginationBoundError,
} from "../http";
import { SLACK_RECONCILIATION_OPERATIONS, SLACK_TOOL_IDS } from "./contracts";
import { normalizeEmojiName, SlackEmojiDirectory, type SlackEmojiDirectoryPort } from "./emoji";
import { encodeMentionsInText, encodeRawIdsInText, type SlackUserLookupPort } from "./mentions";

type DeliveryPort = Pick<ChannelRunDeliveryStore, "find"> & {
  markAcknowledged(businessId: string, runId: string, emoji: string): Promise<unknown>;
  ownsSlackMessage?: ChannelRunDeliveryStore["ownsSlackMessage"];
  ownsSlackReaction?: ChannelRunDeliveryStore["ownsSlackReaction"];
};

export type SlackOwnedObjectType = "message" | "reaction" | "file" | "bookmark" | "pin";

export interface SlackIntegrationIdentityPort {
  resolve(businessId: string): Promise<string | undefined>;
}

interface SlackOwnedObjectKey {
  readonly businessId: string;
  readonly integrationId: string;
  readonly objectType: SlackOwnedObjectType;
  readonly providerObjectId: string;
  readonly channelId: string;
}

export interface SlackOwnedObjectPort {
  owns(input: SlackOwnedObjectKey): Promise<boolean>;
  record(
    input: SlackOwnedObjectKey & {
      readonly creationRunId: string;
      readonly creationIntentId: string;
    }
  ): Promise<void>;
  remove(input: SlackOwnedObjectKey): Promise<void>;
  findByCreationIntent(input: {
    readonly businessId: string;
    readonly integrationId: string;
    readonly creationIntentId: string;
  }): Promise<
    | (SlackOwnedObjectKey & {
        readonly creationRunId: string;
        readonly creationIntentId: string;
      })
    | undefined
  >;
}

export interface SlackFileUploadState {
  readonly businessId: string;
  readonly integrationId: string;
  readonly creationIntentId: string;
  readonly creationRunId: string;
  readonly channelId: string;
  readonly sourceFileId: string;
  readonly sourceSha256: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly providerFileId: string;
  readonly phase: "url_requested" | "bytes_uploaded" | "completed";
}

export interface SlackFileUploadStatePort {
  find(input: {
    businessId: string;
    integrationId: string;
    creationIntentId: string;
  }): Promise<SlackFileUploadState | undefined>;
  urlRequested(input: Omit<SlackFileUploadState, "phase">): Promise<void>;
  advance(input: {
    businessId: string;
    integrationId: string;
    creationIntentId: string;
    providerFileId: string;
    from: "url_requested" | "bytes_uploaded";
    to: "bytes_uploaded" | "completed";
  }): Promise<void>;
}

export interface SlackReconciliationCredentialPort {
  resolve(businessId: string): Promise<string | undefined>;
}

export interface SlackToolAdapterDeps {
  readonly http: IntegrationHttpPort;
  readonly channelRunDelivery?: DeliveryPort;
  readonly integrationIdentity?: SlackIntegrationIdentityPort;
  readonly ownedObjects?: SlackOwnedObjectPort;
  readonly files?: SlackFileUploadSource;
  readonly externalUpload?: SlackExternalUploadPort;
  readonly fileUploads?: SlackFileUploadStatePort;
  readonly reconciliationCredential?: SlackReconciliationCredentialPort;
}

/*
 * The ownership row is the authority boundary. Provider IDs from Tool arguments only select a row;
 * they never prove that the current Slack Integration created the object.
 */
interface OwnedObjectInput {
  businessId: string;
  integrationId: string;
  objectType: SlackOwnedObjectType;
  providerObjectId: string;
  channelId: string;
}

export interface SlackFileUploadSource {
  load(input: { businessId: string; runId: string; fileId: string }): Promise<{
    readonly filename: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }>;
}

export interface SlackExternalUploadPort {
  upload(url: string, bytes: Uint8Array, mediaType: string): Promise<void>;
}

interface SlackApiChannel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly is_member?: unknown;
  readonly is_im?: unknown;
  readonly is_mpim?: unknown;
  readonly is_private?: unknown;
  readonly topic?: { readonly value?: unknown };
  readonly purpose?: { readonly value?: unknown };
}

interface SlackApiMessage {
  readonly ts?: unknown;
  readonly text?: unknown;
  readonly user?: unknown;
  readonly thread_ts?: unknown;
  readonly edited?: unknown;
  readonly subtype?: unknown;
  readonly message?: unknown;
}

interface SlackApiUser {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly deleted?: unknown;
  readonly is_bot?: unknown;
  readonly is_app_user?: unknown;
  readonly profile?: { readonly display_name?: unknown; readonly real_name?: unknown };
  readonly real_name?: unknown;
}

interface BookmarkArguments {
  readonly operation: "list" | "add" | "edit" | "remove";
  readonly channel: string;
  readonly bookmarkId?: string;
  readonly title?: string;
  readonly link?: string;
  readonly emoji?: string;
}

interface SlackUploadSource {
  readonly sourceFileId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sourceSha256: string;
  readonly bytes: Uint8Array;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textArg(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

function bookmarkArguments(raw: Record<string, unknown>): BookmarkArguments {
  const operation = textArg(raw, "operation");
  const channel = textArg(raw, "channel");
  const bookmarkId = optionalText(raw, "bookmarkId");
  const title = optionalText(raw, "title");
  const link = optionalText(raw, "link");
  const emoji = optionalText(raw, "emoji");
  if (
    (operation === "list" &&
      (bookmarkId !== undefined ||
        title !== undefined ||
        link !== undefined ||
        emoji !== undefined)) ||
    (operation === "add" &&
      (bookmarkId !== undefined || title === undefined || link === undefined)) ||
    (operation === "edit" &&
      (bookmarkId === undefined ||
        (title === undefined && link === undefined && emoji === undefined))) ||
    (operation === "remove" &&
      (bookmarkId === undefined ||
        title !== undefined ||
        link !== undefined ||
        emoji !== undefined))
  ) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  if (
    operation !== "list" &&
    operation !== "add" &&
    operation !== "edit" &&
    operation !== "remove"
  ) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return {
    operation,
    channel,
    ...(bookmarkId === undefined ? {} : { bookmarkId }),
    ...(title === undefined ? {} : { title }),
    ...(link === undefined ? {} : { link }),
    ...(emoji === undefined ? {} : { emoji }),
  };
}

function isChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{8,}$/.test(value);
}

function normalizeChannelName(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

function nextCursor(body: Record<string, unknown>): string | undefined {
  const cursor = record(body.response_metadata).next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

function candidateNames(user: SlackApiUser): readonly string[] {
  return [user.name, user.profile?.display_name, user.profile?.real_name, user.real_name].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function userView(value: unknown) {
  const user = record(value);
  const profile = record(user.profile);
  const id = user.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const displayName =
    typeof profile.display_name === "string" && profile.display_name.length > 0
      ? profile.display_name
      : typeof user.name === "string"
        ? user.name
        : "";
  return {
    id,
    displayName,
    isBotOrApp: user.is_bot === true || user.is_app_user === true,
    deleted: user.deleted === true,
  };
}

function messageHistoryArgs(intent: ToolAdapterRequest["intent"]): {
  channel: string;
  cursor?: string;
  oldest?: string;
  threadTs?: string;
  limit: number;
} {
  const raw = intent.arguments as Record<string, unknown>;
  const channel = raw.channel;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const optionalString = (name: "cursor" | "oldest" | "threadTs") => {
    const value = raw[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    return value;
  };
  const limit = raw.limit ?? 100;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  const cursor = optionalString("cursor");
  const oldest = optionalString("oldest");
  const threadTs = optionalString("threadTs");
  return {
    channel: channel.trim(),
    limit: Number(limit),
    ...(cursor === undefined ? {} : { cursor }),
    ...(oldest === undefined ? {} : { oldest }),
    ...(threadTs === undefined ? {} : { threadTs }),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SlackToolAdapter implements ToolAdapter, ToolReconciliationAdapter {
  readonly kind = "integration" as const;
  private readonly emojiDirectories = new Map<string, SlackEmojiDirectory>();

  constructor(private readonly deps: SlackToolAdapterDeps) {}

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    if (credential === undefined) {
      throw new AdapterDispatchError("before_dispatch", "credential_missing", false);
    }
    switch (request.intent.toolId) {
      case SLACK_TOOL_IDS.listChannels:
        return { channels: await this.listChannels(credential) };
      case SLACK_TOOL_IDS.getConversation:
        return this.getConversation(request, credential);
      case SLACK_TOOL_IDS.listMessages:
        return this.listMessages(request, credential);
      case SLACK_TOOL_IDS.sendMessage:
        return this.sendMessage(request, credential);
      case SLACK_TOOL_IDS.updateMessage:
        return this.updateMessage(request, credential);
      case SLACK_TOOL_IDS.deleteMessage:
        return this.deleteMessage(request, credential);
      case SLACK_TOOL_IDS.acknowledge:
        return this.acknowledge(request, credential);
      case SLACK_TOOL_IDS.removeReaction:
        return this.removeReaction(request, credential);
      case SLACK_TOOL_IDS.uploadFile:
        return this.uploadFile(request, credential);
      case SLACK_TOOL_IDS.getFileInfo:
        return this.getFileInfo(request, credential);
      case SLACK_TOOL_IDS.manageBookmark:
        return this.manageBookmark(request, credential);
      case SLACK_TOOL_IDS.managePin:
        return this.managePin(request, credential);
      case SLACK_TOOL_IDS.lookupUser:
        return this.lookupUser(request, credential);
      default:
        throw new AdapterDispatchError("before_dispatch", "unsupported_tool", false);
    }
  }

  async reconcile(
    request: ToolReconciliationRequest,
    suppliedCredential?: string
  ): Promise<ToolReconciliationOutcome> {
    const credential =
      suppliedCredential ??
      (await this.deps.reconciliationCredential?.resolve(request.intent.businessId));
    if (credential === undefined) {
      return { outcome: "ambiguous", evidenceRef: "slack:credential_unavailable" };
    }
    try {
      switch (request.operation) {
        case SLACK_RECONCILIATION_OPERATIONS.sendMessage:
          return await this.reconcileSentMessage(request, credential);
        case SLACK_RECONCILIATION_OPERATIONS.updateMessage:
          return await this.reconcileUpdatedMessage(request, credential);
        case SLACK_RECONCILIATION_OPERATIONS.deleteMessage:
          return await this.reconcileDeletedMessage(request, credential);
        case SLACK_RECONCILIATION_OPERATIONS.uploadFile:
          return await this.reconcileFileUpload(request, credential);
        case SLACK_RECONCILIATION_OPERATIONS.manageBookmark:
          return await this.reconcileBookmark(request, credential);
        default:
          return { outcome: "ambiguous", evidenceRef: "slack:lookup_unsupported" };
      }
    } catch {
      return { outcome: "ambiguous", evidenceRef: "slack:lookup_failed" };
    }
  }

  private reconciliationRequest(request: ToolReconciliationRequest): ToolAdapterRequest {
    return {
      intent: request.intent,
      idempotencyKey: request.idempotencyKey,
      attempt: 1,
    };
  }

  private async reconcileSentMessage(
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const adapterRequest = this.reconciliationRequest(request);
    const channelId = await this.resolveJoinedChannel(
      textArg(record(request.intent.arguments), "channel"),
      credential
    );
    const threadTs = await this.originatingThreadTs(adapterRequest, channelId, credential);
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body = await this.api(
        credential,
        threadTs === undefined ? "/conversations.history" : "/conversations.replies",
        {
          method: "GET",
          query: {
            channel: channelId,
            limit: "200",
            ...(threadTs === undefined ? {} : { ts: threadTs }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        }
      );
      for (const value of Array.isArray(body.messages) ? body.messages : []) {
        const message = record(value);
        if (message.client_msg_id === request.idempotencyKey && typeof message.ts === "string") {
          await this.recordOwned(
            adapterRequest,
            { objectType: "message", providerObjectId: message.ts, channelId },
            true
          );
          return {
            outcome: "confirmed",
            evidenceRef: `slack:message:${channelId}:${message.ts}`,
          };
        }
      }
      cursor = nextCursor(body);
      if (cursor === undefined) {
        return {
          outcome: "not_applied",
          evidenceRef: `slack:message:absent:${channelId}:${request.idempotencyKey}`,
        };
      }
    }
    return {
      outcome: "ambiguous",
      evidenceRef: `slack:message:pagination_bound:${channelId}`,
    };
  }

  private async reconcileUpdatedMessage(
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const ts = textArg(raw, "ts");
    await this.owned(this.reconciliationRequest(request), {
      objectType: "message",
      providerObjectId: ts,
      channelId,
    });
    const current = await this.findMessage(channelId, ts, credential);
    return current?.text === textArg(raw, "text")
      ? { outcome: "confirmed", evidenceRef: `slack:message:${channelId}:${ts}` }
      : { outcome: "not_applied", evidenceRef: `slack:message:not_updated:${channelId}:${ts}` };
  }

  private async reconcileDeletedMessage(
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const ts = textArg(raw, "ts");
    const owned = await this.owned(this.reconciliationRequest(request), {
      objectType: "message",
      providerObjectId: ts,
      channelId,
    });
    if ((await this.findMessage(channelId, ts, credential)) !== undefined) {
      return { outcome: "not_applied", evidenceRef: `slack:message:present:${channelId}:${ts}` };
    }
    await this.deps.ownedObjects?.remove(owned);
    return { outcome: "confirmed", evidenceRef: `slack:message:absent:${channelId}:${ts}` };
  }

  private async reconcileFileUpload(
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const state = await this.fileUploadState(request);
    if (state === undefined) {
      return {
        outcome: "ambiguous",
        evidenceRef: `slack:file:state_missing:${request.intent.intentId}`,
      };
    }
    const adapterRequest = this.reconciliationRequest(request);
    const source = await this.loadUploadSource(adapterRequest);
    if (!this.matchesUploadSource(state, source)) {
      return {
        outcome: "ambiguous",
        evidenceRef: `slack:file:source_changed:${request.intent.intentId}`,
      };
    }
    try {
      await this.resumeFileUpload(adapterRequest, state, source, credential);
      return {
        outcome: "confirmed",
        evidenceRef: `slack:file:${state.channelId}:${state.providerFileId}`,
      };
    } catch {
      return {
        outcome: "ambiguous",
        evidenceRef: `slack:file:resume_failed:${state.channelId}:${state.providerFileId}`,
      };
    }
  }

  private async reconcileBookmark(
    request: ToolReconciliationRequest,
    credential: string
  ): Promise<ToolReconciliationOutcome> {
    const args = bookmarkArguments(record(request.intent.arguments));
    const channelId = await this.resolveJoinedChannel(args.channel, credential);
    if (args.operation === "list") {
      return { outcome: "confirmed", evidenceRef: `slack:bookmarks:list:${channelId}` };
    }
    if (args.operation === "add") {
      const existing = await this.createdObject(request, "bookmark");
      if (existing !== undefined) {
        return {
          outcome: "confirmed",
          evidenceRef: `slack:bookmark:${channelId}:${existing.providerObjectId}`,
        };
      }
      return {
        outcome: "ambiguous",
        evidenceRef: `slack:bookmark:ownership_missing:${channelId}`,
      };
    }
    const bookmarkId = args.bookmarkId;
    if (bookmarkId === undefined) {
      return { outcome: "ambiguous", evidenceRef: `slack:bookmark:invalid:${channelId}` };
    }
    const owned = await this.owned(this.reconciliationRequest(request), {
      objectType: "bookmark",
      providerObjectId: bookmarkId,
      channelId,
    });
    const current = (await this.listBookmarks(channelId, credential)).find(
      (bookmark) => bookmark.id === bookmarkId
    );
    if (args.operation === "remove") {
      if (current !== undefined) {
        return {
          outcome: "not_applied",
          evidenceRef: `slack:bookmark:present:${channelId}:${bookmarkId}`,
        };
      }
      await this.deps.ownedObjects?.remove(owned);
      return {
        outcome: "confirmed",
        evidenceRef: `slack:bookmark:absent:${channelId}:${bookmarkId}`,
      };
    }
    const matches =
      current !== undefined &&
      (args.title === undefined || current.title === args.title) &&
      (args.link === undefined || current.link === args.link) &&
      (args.emoji === undefined || current.emoji === args.emoji);
    return matches
      ? {
          outcome: "confirmed",
          evidenceRef: `slack:bookmark:${channelId}:${bookmarkId}`,
        }
      : {
          outcome: "not_applied",
          evidenceRef: `slack:bookmark:not_updated:${channelId}:${bookmarkId}`,
        };
  }

  private async createdObject(
    request: ToolReconciliationRequest,
    objectType: SlackOwnedObjectType
  ): Promise<OwnedObjectInput | undefined> {
    const integrationId = await this.integrationId(this.reconciliationRequest(request));
    const owned = await this.deps.ownedObjects?.findByCreationIntent({
      businessId: request.intent.businessId,
      integrationId,
      creationIntentId: request.intent.intentId,
    });
    if (owned === undefined || owned.objectType !== objectType) return undefined;
    return owned;
  }

  private async api(
    credential: string,
    path: string,
    input: {
      method?: "GET" | "POST";
      query?: Readonly<Record<string, string>>;
      body?: unknown;
      mutating?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    const response = await this.deps.http.send(
      {
        method: input.method ?? "POST",
        path,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      credential
    );
    const body = record(response.body);
    const failure = classifyHttpFailure(response, input.mutating === true);
    if (failure !== null || body.ok !== true) {
      const code =
        typeof body.error === "string" ? body.error : (failure?.code ?? "provider_error");
      throw new AdapterDispatchError(
        failure?.phase ?? "before_dispatch",
        code,
        failure?.retryable ?? false
      );
    }
    return body;
  }

  private async resolveJoinedChannel(channel: string, credential: string): Promise<string> {
    const channelId = isChannelId(channel)
      ? channel
      : await this.resolveChannelId(normalizeChannelName(channel), credential);
    const info = await this.api(credential, "/conversations.info", {
      method: "GET",
      query: { channel: channelId },
    });
    const conversation = record(info.channel);
    if (
      conversation.is_member !== true &&
      conversation.is_im !== true &&
      conversation.is_mpim !== true
    ) {
      throw new AdapterDispatchError("before_dispatch", "channel_not_joined", false);
    }
    return channelId;
  }

  private async getConversation(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const threadTs = optionalText(raw, "threadTs");
    const limit = typeof raw.limit === "number" ? Math.min(raw.limit, 200) : 100;
    const cursor = optionalText(raw, "cursor");
    const info = await this.api(credential, "/conversations.info", {
      method: "GET",
      query: { channel: channelId },
    });
    const page = await this.api(
      credential,
      threadTs === undefined ? "/conversations.history" : "/conversations.replies",
      {
        method: "GET",
        query: {
          channel: channelId,
          limit: String(limit),
          ...(threadTs === undefined ? {} : { ts: threadTs }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      }
    );
    const conversation = record(info.channel);
    const messages = (Array.isArray(page.messages) ? page.messages : []).flatMap((value) => {
      const message = record(value);
      if (typeof message.ts !== "string" || typeof message.text !== "string") return [];
      return [
        {
          ts: message.ts,
          text: message.text,
          ...(typeof message.user === "string" ? { userId: message.user } : {}),
          ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
        },
      ];
    });
    return {
      conversation: {
        id: channelId,
        name: typeof conversation.name === "string" ? conversation.name : channelId,
        ...(typeof record(conversation.topic).value === "string"
          ? { topic: record(conversation.topic).value }
          : {}),
        ...(typeof record(conversation.purpose).value === "string"
          ? { purpose: record(conversation.purpose).value }
          : {}),
      },
      messages,
      ...(nextCursor(page) === undefined ? {} : { nextCursor: nextCursor(page) }),
    };
  }

  private async sendMessage(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const text = await encodeMentionsInText(
      encodeRawIdsInText(textArg(raw, "text")),
      this.userLookup(credential)
    );
    const threadTs = await this.originatingThreadTs(request, channelId, credential);
    const body = await this.api(credential, "/chat.postMessage", {
      body: {
        channel: channelId,
        text,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        client_msg_id: request.idempotencyKey,
      },
      mutating: true,
    });
    if (typeof body.ts !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    await this.recordOwned(request, {
      objectType: "message",
      providerObjectId: body.ts,
      channelId,
    });
    return { channelId, ts: body.ts, threadId: body.ts };
  }

  private async integrationId(request: ToolAdapterRequest): Promise<string> {
    const integrationId = await this.deps.integrationIdentity?.resolve(request.intent.businessId);
    if (integrationId === undefined) {
      throw new AdapterDispatchError("before_dispatch", "integration_identity_unavailable", false);
    }
    return integrationId;
  }

  private async owned(
    request: ToolAdapterRequest,
    input: Omit<OwnedObjectInput, "businessId" | "integrationId">
  ): Promise<OwnedObjectInput> {
    const key = {
      businessId: request.intent.businessId,
      integrationId: await this.integrationId(request),
      ...input,
    };
    const stored = await this.deps.ownedObjects?.owns(key);
    const legacy =
      stored === true
        ? true
        : input.objectType === "message"
          ? await this.deps.channelRunDelivery?.ownsSlackMessage?.({
              businessId: key.businessId,
              integrationId: key.integrationId,
              channelId: key.channelId,
              messageTs: key.providerObjectId,
            })
          : input.objectType === "reaction"
            ? await this.ownsDeliveryReaction(key)
            : false;
    if (legacy !== true) {
      throw new AdapterDispatchError(
        "before_dispatch",
        `${input.objectType}_not_integration_owned`,
        false
      );
    }
    return key;
  }

  private async ownsDeliveryReaction(input: OwnedObjectInput): Promise<boolean> {
    const separator = input.providerObjectId.lastIndexOf(":");
    if (separator <= 0) return false;
    return (
      (await this.deps.channelRunDelivery?.ownsSlackReaction?.({
        businessId: input.businessId,
        integrationId: input.integrationId,
        channelId: input.channelId,
        messageTs: input.providerObjectId.slice(0, separator),
        emoji: input.providerObjectId.slice(separator + 1),
      })) === true
    );
  }

  private async recordOwned(
    request: ToolAdapterRequest,
    input: Omit<OwnedObjectInput, "businessId" | "integrationId">,
    required = false,
    retryable = false
  ): Promise<void> {
    if (this.deps.ownedObjects === undefined || this.deps.integrationIdentity === undefined) {
      if (!required) return;
      throw new AdapterDispatchError("after_dispatch", "ownership_tracking_unavailable", false);
    }
    try {
      await this.deps.ownedObjects.record({
        businessId: request.intent.businessId,
        integrationId: await this.integrationId(request),
        ...input,
        creationRunId: request.intent.runId,
        creationIntentId: request.intent.intentId,
      });
    } catch (error) {
      if (error instanceof AdapterDispatchError) throw error;
      throw new AdapterDispatchError("after_dispatch", "ownership_record_failed", retryable);
    }
  }

  private async fileUploadState(
    request: ToolReconciliationRequest
  ): Promise<SlackFileUploadState | undefined> {
    if (this.deps.fileUploads === undefined) return undefined;
    return this.deps.fileUploads.find({
      businessId: request.intent.businessId,
      integrationId: await this.integrationId(this.reconciliationRequest(request)),
      creationIntentId: request.intent.intentId,
    });
  }

  private async loadUploadSource(request: ToolAdapterRequest): Promise<SlackUploadSource> {
    if (this.deps.files === undefined) {
      throw new AdapterDispatchError("before_dispatch", "file_upload_unavailable", false);
    }
    const sourceFileId = textArg(record(request.intent.arguments), "fileId");
    const source = await this.deps.files
      .load({
        businessId: request.intent.businessId,
        runId: request.intent.runId,
        fileId: sourceFileId,
      })
      .catch(() => {
        throw new AdapterDispatchError("before_dispatch", "file_unavailable", false);
      });
    return {
      sourceFileId,
      filename: source.filename,
      mediaType: source.mediaType,
      sizeBytes: source.bytes.byteLength,
      sourceSha256: await sha256(source.bytes),
      bytes: source.bytes,
    };
  }

  private matchesUploadSource(state: SlackFileUploadState, source: SlackUploadSource): boolean {
    return (
      state.sourceFileId === source.sourceFileId &&
      state.sourceSha256 === source.sourceSha256 &&
      state.filename === source.filename &&
      state.mediaType === source.mediaType &&
      state.sizeBytes === source.sizeBytes
    );
  }

  private async updateMessage(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const ts = textArg(raw, "ts");
    const text = textArg(raw, "text");
    await this.owned(request, {
      objectType: "message",
      providerObjectId: ts,
      channelId,
    });
    try {
      const body = await this.api(credential, "/chat.update", {
        body: { channel: channelId, ts, text },
        mutating: true,
      });
      const message = record(body.message);
      const updatedTs = typeof body.ts === "string" ? body.ts : ts;
      return {
        channelId,
        ts: updatedTs,
        threadId: typeof message.thread_ts === "string" ? message.thread_ts : updatedTs,
      };
    } catch (error) {
      if (!(error instanceof AdapterDispatchError) || error.phase !== "after_dispatch") throw error;
      const current = await this.findMessage(channelId, ts, credential);
      if (current?.text !== text) throw error;
      return { channelId, ts, threadId: current.threadTs ?? ts };
    }
  }

  private async deleteMessage(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const ts = textArg(raw, "ts");
    const owned = await this.owned(request, {
      objectType: "message",
      providerObjectId: ts,
      channelId,
    });
    try {
      await this.api(credential, "/chat.delete", {
        body: { channel: channelId, ts },
        mutating: true,
      });
    } catch (error) {
      if (!(error instanceof AdapterDispatchError)) throw error;
      if (error.code === "message_not_found") {
        await this.deps.ownedObjects?.remove(owned);
        return { ok: true };
      }
      if (error.phase !== "after_dispatch" || (await this.findMessage(channelId, ts, credential))) {
        throw error;
      }
    }
    await this.deps.ownedObjects?.remove(owned);
    return { ok: true };
  }

  private async findMessage(
    channelId: string,
    ts: string,
    credential: string
  ): Promise<{ text: string; threadTs?: string } | undefined> {
    try {
      const body = await this.api(credential, "/conversations.history", {
        method: "GET",
        query: { channel: channelId, oldest: ts, latest: ts, inclusive: "true", limit: "1" },
      });
      for (const value of Array.isArray(body.messages) ? body.messages : []) {
        const message = record(value);
        if (message.ts === ts && typeof message.text === "string") {
          return {
            text: message.text,
            ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
          };
        }
      }
      return undefined;
    } catch (error) {
      if (error instanceof AdapterDispatchError && error.code === "message_not_found") {
        return undefined;
      }
      throw error;
    }
  }

  private async acknowledge(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const store = this.deps.channelRunDelivery;
    if (store === undefined) {
      throw new AdapterDispatchError("before_dispatch", "acknowledge_unavailable", false);
    }
    const emoji = textArg(record(request.intent.arguments), "emoji");
    const delivery = await store
      .find(request.intent.businessId, request.intent.runId)
      .catch(() => null);
    if (
      delivery === null ||
      delivery.provider !== "slack" ||
      delivery.sourceMessageTs === undefined
    ) {
      throw new AdapterDispatchError("before_dispatch", "acknowledge_target_unknown", false);
    }
    const resolution = await this.emojiDirectory(credential).resolve(emoji);
    const name = resolution.outcome === "resolved" ? resolution.name : normalizeEmojiName(emoji);
    try {
      await this.api(credential, "/reactions.add", {
        body: { channel: delivery.destination, timestamp: delivery.sourceMessageTs, name },
        mutating: true,
      });
    } catch (error) {
      if (!(error instanceof AdapterDispatchError) || error.code !== "already_reacted") {
        if (
          error instanceof AdapterDispatchError &&
          (error.code === "invalid_name" || error.code === "no_reaction")
        ) {
          const candidates =
            resolution.outcome === "unknown" && resolution.candidates.length > 0
              ? `:${resolution.candidates.join(",")}`
              : "";
          throw new AdapterDispatchError("before_dispatch", `emoji_not_found${candidates}`, false);
        }
        throw error;
      }
    }
    await store.markAcknowledged(request.intent.businessId, request.intent.runId, name);
    await this.recordOwned(request, {
      objectType: "reaction",
      providerObjectId: `${delivery.sourceMessageTs}:${name}`,
      channelId: delivery.destination,
    });
    return { ok: true, emoji: name };
  }

  private async removeReaction(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const timestamp = textArg(raw, "timestamp");
    const emoji = normalizeEmojiName(textArg(raw, "emoji"));
    const owned = await this.owned(request, {
      objectType: "reaction",
      providerObjectId: `${timestamp}:${emoji}`,
      channelId,
    });
    try {
      await this.api(credential, "/reactions.remove", {
        body: { channel: channelId, timestamp, name: emoji },
        mutating: true,
      });
    } catch (error) {
      if (!(error instanceof AdapterDispatchError) || error.code !== "no_reaction") throw error;
    }
    await this.deps.ownedObjects?.remove(owned);
    return { ok: true, emoji };
  }

  private async uploadFile(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    if (
      this.deps.files === undefined ||
      this.deps.externalUpload === undefined ||
      this.deps.fileUploads === undefined ||
      this.deps.ownedObjects === undefined ||
      this.deps.integrationIdentity === undefined
    ) {
      throw new AdapterDispatchError("before_dispatch", "file_upload_unavailable", false);
    }
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const source = await this.loadUploadSource(request);
    const integrationId = await this.integrationId(request);
    const existing = await this.deps.fileUploads.find({
      businessId: request.intent.businessId,
      integrationId,
      creationIntentId: request.intent.intentId,
    });
    if (existing !== undefined) {
      if (existing.channelId !== channelId || !this.matchesUploadSource(existing, source)) {
        throw new AdapterDispatchError("after_dispatch", "file_upload_state_mismatch", false);
      }
      return this.resumeFileUpload(request, existing, source, credential);
    }
    const upload = await this.api(credential, "/files.getUploadURLExternal", {
      body: { filename: source.filename, length: source.bytes.byteLength },
      mutating: true,
    });
    const uploadUrl = upload.upload_url;
    const uploadId = upload.file_id;
    if (typeof uploadUrl !== "string" || typeof uploadId !== "string") {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    const state: SlackFileUploadState = {
      businessId: request.intent.businessId,
      integrationId,
      creationIntentId: request.intent.intentId,
      creationRunId: request.intent.runId,
      channelId,
      sourceFileId: source.sourceFileId,
      sourceSha256: source.sourceSha256,
      filename: source.filename,
      mediaType: source.mediaType,
      sizeBytes: source.sizeBytes,
      providerFileId: uploadId,
      phase: "url_requested",
    };
    try {
      await this.deps.fileUploads.urlRequested(state);
    } catch {
      throw new AdapterDispatchError("after_dispatch", "upload_stage_record_failed", false);
    }
    return this.resumeFileUpload(request, state, source, credential, uploadUrl);
  }

  private async resumeFileUpload(
    request: ToolAdapterRequest,
    state: SlackFileUploadState,
    source: SlackUploadSource,
    credential: string,
    currentUploadUrl?: string
  ): Promise<unknown> {
    const fileUploads = this.deps.fileUploads;
    const externalUpload = this.deps.externalUpload;
    if (fileUploads === undefined || externalUpload === undefined) {
      throw new AdapterDispatchError("before_dispatch", "file_upload_unavailable", false);
    }
    let current = state;
    let uploadUrl = currentUploadUrl;
    if (current.phase === "url_requested") {
      if (uploadUrl === undefined) {
        const renewed = await this.api(credential, "/files.getUploadURLExternal", {
          body: { filename: source.filename, length: source.sizeBytes },
          mutating: true,
        });
        if (typeof renewed.upload_url !== "string" || typeof renewed.file_id !== "string") {
          throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
        }
        uploadUrl = renewed.upload_url;
        current = { ...current, providerFileId: renewed.file_id };
        try {
          await fileUploads.urlRequested(current);
        } catch {
          throw new AdapterDispatchError("after_dispatch", "upload_stage_record_failed", false);
        }
      }
      await externalUpload.upload(uploadUrl, source.bytes, source.mediaType).catch(() => {
        throw new AdapterDispatchError("after_dispatch", "file_byte_upload_failed", false);
      });
      try {
        await fileUploads.advance({
          businessId: current.businessId,
          integrationId: current.integrationId,
          creationIntentId: current.creationIntentId,
          providerFileId: current.providerFileId,
          from: "url_requested",
          to: "bytes_uploaded",
        });
      } catch {
        throw new AdapterDispatchError("after_dispatch", "upload_stage_record_failed", false);
      }
      current = { ...current, phase: "bytes_uploaded" };
    }
    if (current.phase === "bytes_uploaded") {
      try {
        const raw = record(request.intent.arguments);
        const completed = await this.api(credential, "/files.completeUploadExternal", {
          body: {
            files: [
              {
                id: current.providerFileId,
                title: optionalText(raw, "title") ?? source.filename,
              },
            ],
            channel_id: current.channelId,
            ...(optionalText(raw, "initialComment") === undefined
              ? {}
              : { initial_comment: optionalText(raw, "initialComment") }),
            ...(optionalText(raw, "threadTs") === undefined
              ? {}
              : { thread_ts: optionalText(raw, "threadTs") }),
          },
          mutating: true,
        });
        const completedFile = record(
          Array.isArray(completed.files) ? completed.files[0] : undefined
        );
        if (typeof completedFile.id === "string" && completedFile.id !== current.providerFileId) {
          throw new AdapterDispatchError("after_dispatch", "file_id_mismatch", false);
        }
      } catch (error) {
        const existing = await this.readUploadedFile(
          current.providerFileId,
          current.channelId,
          credential
        );
        if (existing === undefined) throw error;
      }
      try {
        await fileUploads.advance({
          businessId: current.businessId,
          integrationId: current.integrationId,
          creationIntentId: current.creationIntentId,
          providerFileId: current.providerFileId,
          from: "bytes_uploaded",
          to: "completed",
        });
      } catch {
        throw new AdapterDispatchError("after_dispatch", "ownership_record_failed", false);
      }
      current = { ...current, phase: "completed" };
    }
    await this.recordOwned(
      request,
      {
        objectType: "file",
        providerObjectId: current.providerFileId,
        channelId: current.channelId,
      },
      true
    );
    const file = await this.readUploadedFile(
      current.providerFileId,
      current.channelId,
      credential
    ).catch(() => {
      throw new AdapterDispatchError("after_dispatch", "file_info_unavailable", false);
    });
    if (file === undefined) {
      throw new AdapterDispatchError("after_dispatch", "file_info_unavailable", false);
    }
    return this.fileView(file);
  }

  private async readUploadedFile(
    providerFileId: string,
    channelId: string,
    credential: string
  ): Promise<unknown | undefined> {
    try {
      const info = await this.api(credential, "/files.info", {
        method: "GET",
        query: { file: providerFileId },
      });
      const file = record(info.file);
      const conversations = [
        ...(Array.isArray(file.channels) ? file.channels : []),
        ...(Array.isArray(file.groups) ? file.groups : []),
        ...(Array.isArray(file.ims) ? file.ims : []),
      ];
      return file.id === providerFileId && conversations.includes(channelId) ? file : undefined;
    } catch (error) {
      if (error instanceof AdapterDispatchError && error.code === "file_not_found") {
        return undefined;
      }
      throw error;
    }
  }

  private async getFileInfo(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    const fileId = textArg(raw, "fileId");
    await this.owned(request, {
      objectType: "file",
      providerObjectId: fileId,
      channelId,
    });
    const body = await this.api(credential, "/files.info", {
      method: "GET",
      query: { file: fileId },
    });
    return this.fileView(body.file);
  }

  private fileView(value: unknown) {
    const file = record(value);
    if (
      typeof file.id !== "string" ||
      typeof file.name !== "string" ||
      typeof file.mimetype !== "string" ||
      typeof file.size !== "number"
    ) {
      throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
    }
    return {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      size: file.size,
      ...(typeof file.created === "number" ? { created: file.created } : {}),
    };
  }

  private async manageBookmark(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const args = bookmarkArguments(record(request.intent.arguments));
    const { operation } = args;
    const channelId = await this.resolveJoinedChannel(args.channel, credential);
    if (operation === "list") return { bookmarks: await this.listBookmarks(channelId, credential) };
    const bookmarkId = args.bookmarkId;
    let owned: OwnedObjectInput | undefined;
    if (operation !== "add") {
      if (bookmarkId === undefined) {
        throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
      }
      owned = await this.owned(request, {
        objectType: "bookmark",
        providerObjectId: bookmarkId,
        channelId,
      });
    }
    const path =
      operation === "add"
        ? "/bookmarks.add"
        : operation === "edit"
          ? "/bookmarks.edit"
          : "/bookmarks.remove";
    const body = {
      channel_id: channelId,
      ...(operation === "add" ? { type: "link" } : {}),
      ...(bookmarkId === undefined ? {} : { bookmark_id: bookmarkId }),
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.link === undefined ? {} : { link: args.link }),
      ...(args.emoji === undefined ? {} : { emoji: args.emoji }),
    };
    try {
      const result = await this.api(credential, path, { body, mutating: true });
      const returned = record(result.bookmark);
      const returnedId = typeof returned.id === "string" ? returned.id : bookmarkId;
      if (operation === "add") {
        if (returnedId === undefined) {
          throw new AdapterDispatchError("after_dispatch", "invalid_response", false);
        }
        await this.recordOwned(
          request,
          {
            objectType: "bookmark",
            providerObjectId: returnedId,
            channelId,
          },
          true
        );
      }
      if (operation === "remove" && owned !== undefined) {
        await this.deps.ownedObjects?.remove(owned);
      }
    } catch (error) {
      if (!(error instanceof AdapterDispatchError)) throw error;
      if (operation === "add") throw error;
      const bookmarks = await this.listBookmarks(channelId, credential);
      const matches =
        bookmarkId === undefined ? [] : bookmarks.filter((bookmark) => bookmark.id === bookmarkId);
      const match = matches.length === 1 ? matches[0] : undefined;
      const converged =
        (operation === "remove" && match === undefined) ||
        (operation === "edit" &&
          match !== undefined &&
          (args.title === undefined || match.title === args.title) &&
          (args.link === undefined || match.link === args.link) &&
          (args.emoji === undefined || match.emoji === args.emoji));
      if (!converged) throw error;
      if (operation === "remove" && owned !== undefined) {
        await this.deps.ownedObjects?.remove(owned);
      }
    }
    return { bookmarks: await this.listBookmarks(channelId, credential) };
  }

  private async listBookmarks(channelId: string, credential: string) {
    const body = await this.api(credential, "/bookmarks.list", {
      method: "GET",
      query: { channel_id: channelId },
    });
    return (Array.isArray(body.bookmarks) ? body.bookmarks : []).slice(0, 100).flatMap((value) => {
      const bookmark = record(value);
      if (
        typeof bookmark.id !== "string" ||
        typeof bookmark.title !== "string" ||
        typeof bookmark.link !== "string"
      ) {
        return [];
      }
      return [
        {
          id: bookmark.id,
          title: bookmark.title,
          link: bookmark.link,
          ...(typeof bookmark.emoji === "string" ? { emoji: bookmark.emoji } : {}),
        },
      ];
    });
  }

  private async managePin(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const operation = textArg(raw, "operation");
    const channelId = await this.resolveJoinedChannel(textArg(raw, "channel"), credential);
    if (operation === "list") return { pins: await this.listPins(channelId, credential) };
    if (operation !== "add" && operation !== "remove") {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const ts = textArg(raw, "timestamp");
    const pinsBefore = operation === "add" ? await this.listPins(channelId, credential) : undefined;
    if (pinsBefore?.some((pin) => pin.timestamp === ts) === true) {
      if (request.attempt > 1) {
        await this.recordOwned(
          request,
          {
            objectType: "pin",
            providerObjectId: ts,
            channelId,
          },
          true,
          true
        );
      }
      return { pins: pinsBefore };
    }
    const owned =
      operation === "remove"
        ? await this.owned(request, {
            objectType: "pin",
            providerObjectId: ts,
            channelId,
          })
        : undefined;
    try {
      await this.api(credential, operation === "add" ? "/pins.add" : "/pins.remove", {
        body: { channel: channelId, timestamp: ts },
        mutating: true,
      });
    } catch (error) {
      if (!(error instanceof AdapterDispatchError)) throw error;
      const exists = (await this.listPins(channelId, credential)).some(
        (pin) => pin.timestamp === ts
      );
      if ((operation === "add" && !exists) || (operation === "remove" && exists)) throw error;
    }
    if (operation === "add") {
      await this.recordOwned(
        request,
        {
          objectType: "pin",
          providerObjectId: ts,
          channelId,
        },
        true,
        true
      );
    } else if (owned !== undefined) {
      await this.deps.ownedObjects?.remove(owned);
    }
    return { pins: await this.listPins(channelId, credential) };
  }

  private async listPins(channelId: string, credential: string) {
    const body = await this.api(credential, "/pins.list", {
      method: "GET",
      query: { channel: channelId },
    });
    return (Array.isArray(body.items) ? body.items : []).slice(0, 100).flatMap((value) => {
      const item = record(value);
      const message = record(item.message);
      if (typeof message.ts !== "string") return [];
      return [
        {
          timestamp: message.ts,
          ...(typeof message.text === "string" ? { text: message.text } : {}),
        },
      ];
    });
  }

  private async lookupUser(request: ToolAdapterRequest, credential: string): Promise<unknown> {
    const raw = record(request.intent.arguments);
    const userId = optionalText(raw, "userId");
    if (userId !== undefined) {
      const body = await this.api(credential, "/users.info", {
        method: "GET",
        query: { user: userId },
      });
      const user = userView(body.user);
      return { users: user === undefined ? [] : [user] };
    }
    const query = textArg(raw, "query").toLowerCase();
    const limit = typeof raw.limit === "number" ? Math.min(raw.limit, 20) : 10;
    try {
      const users = await collectPages<SlackApiUser>(
        async (cursor) => {
          const body = await this.api(credential, "/users.list", {
            method: "GET",
            query: { limit: "200", ...(cursor === undefined ? {} : { cursor }) },
          });
          return {
            items: Array.isArray(body.members) ? (body.members as SlackApiUser[]) : [],
            ...(nextCursor(body) === undefined ? {} : { nextCursor: nextCursor(body) }),
          };
        },
        { maxPages: 20, maxItems: 4_000 }
      );
      return {
        users: users
          .filter((user) =>
            candidateNames(user).some((name) => name.toLowerCase().startsWith(query))
          )
          .flatMap((user) => {
            const view = userView(user);
            return view === undefined ? [] : [view];
          })
          .slice(0, limit),
      };
    } catch (error) {
      if (error instanceof PaginationBoundError) {
        throw new AdapterDispatchError("before_dispatch", "pagination_bound_exceeded", false);
      }
      throw error;
    }
  }

  private emojiDirectory(credential: string): SlackEmojiDirectory {
    const existing = this.emojiDirectories.get(credential);
    if (existing !== undefined) return existing;
    const port: SlackEmojiDirectoryPort = {
      load: async () => {
        const body = await this.api(credential, "/emoji.list", { method: "GET" });
        const names: Record<string, string> = {};
        for (const [key, value] of Object.entries(record(body.emoji))) {
          if (typeof value === "string") names[key] = value;
        }
        return names;
      },
    };
    const directory = new SlackEmojiDirectory(port);
    this.emojiDirectories.set(credential, directory);
    return directory;
  }

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

  private async resolveChannelId(name: string, credential: string): Promise<string> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body = await this.api(credential, "/conversations.list", {
        method: "GET",
        query: {
          types: "public_channel,private_channel,im,mpim",
          limit: "200",
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      const channels = Array.isArray(body.channels) ? (body.channels as SlackApiChannel[]) : [];
      const match = channels.find(
        (candidate) => candidate.name === name && typeof candidate.id === "string"
      );
      if (match !== undefined && typeof match.id === "string") return match.id;
      cursor = nextCursor(body);
      if (cursor === undefined) break;
    }
    throw new AdapterDispatchError("before_dispatch", "channel_not_found", false);
  }

  private async listChannels(credential: string): Promise<{ id: string; name: string }[]> {
    try {
      const channels = await collectPages<SlackApiChannel>(
        async (cursor) => {
          const body = await this.api(credential, "/conversations.list", {
            method: "GET",
            query: {
              types: "public_channel,private_channel,im,mpim",
              exclude_archived: "true",
              limit: "100",
              ...(cursor === undefined ? {} : { cursor }),
            },
          });
          return {
            items: Array.isArray(body.channels) ? (body.channels as SlackApiChannel[]) : [],
            ...(nextCursor(body) === undefined ? {} : { nextCursor: nextCursor(body) }),
          };
        },
        { maxPages: 20, maxItems: 4_000 }
      );
      return channels
        .flatMap((candidate) =>
          (candidate.is_member === true ||
            candidate.is_im === true ||
            candidate.is_mpim === true) &&
          typeof candidate.id === "string" &&
          typeof candidate.name === "string"
            ? [{ id: candidate.id, name: candidate.name }]
            : []
        )
        .slice(0, 100);
    } catch (error) {
      if (error instanceof PaginationBoundError) {
        throw new AdapterDispatchError("before_dispatch", "pagination_bound_exceeded", false);
      }
      throw error;
    }
  }

  private userLookup(credential: string): SlackUserLookupPort {
    let directory:
      | Promise<{ exact: Map<string, string>; firstName: Map<string, string | null> }>
      | undefined;
    return {
      resolveUserId: async (name) => {
        directory ??= this.loadUserDirectory(credential).catch(() => ({
          exact: new Map(),
          firstName: new Map(),
        }));
        const { exact, firstName } = await directory;
        const lower = name.toLowerCase();
        return exact.get(lower) ?? firstName.get(lower) ?? undefined;
      },
    };
  }

  private async loadUserDirectory(credential: string) {
    const exact = new Map<string, string>();
    const firstName = new Map<string, string | null>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body = await this.api(credential, "/users.list", {
        method: "GET",
        query: { limit: "200", ...(cursor === undefined ? {} : { cursor }) },
      });
      const members = Array.isArray(body.members) ? (body.members as SlackApiUser[]) : [];
      for (const member of members) {
        if (typeof member.id !== "string") continue;
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
      cursor = nextCursor(body);
      if (cursor === undefined) break;
    }
    return { exact, firstName };
  }

  private async listMessages(
    request: ToolAdapterRequest,
    credential: string
  ): Promise<{
    channelId: string;
    messages: {
      ts: string;
      text: string;
      userId?: string;
      threadTs?: string;
      editedTs?: string;
    }[];
    nextCursor?: string;
  }> {
    const input = messageHistoryArgs(request.intent);
    const channelId = await this.resolvePublicChannelId(input.channel, credential);
    const page = await this.api(
      credential,
      input.threadTs === undefined ? "/conversations.history" : "/conversations.replies",
      {
        method: "GET",
        query: {
          channel: channelId,
          limit: String(input.limit),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.threadTs === undefined
            ? input.oldest === undefined
              ? {}
              : { oldest: input.oldest }
            : { ts: input.threadTs }),
        },
      }
    );

    const rawMessages = Array.isArray(page.messages) ? (page.messages as SlackApiMessage[]) : [];
    const messages = rawMessages.flatMap((raw) => {
      if (raw.subtype === "message_deleted") return [];
      const source =
        raw.subtype === "message_changed" && record(raw.message).ts !== undefined
          ? (record(raw.message) as SlackApiMessage)
          : raw;
      if (typeof source.ts !== "string" || typeof source.text !== "string") return [];
      const edited = record(source.edited).ts;
      return [
        {
          ts: source.ts,
          text: source.text,
          ...(typeof source.user === "string" ? { userId: source.user } : {}),
          ...(typeof source.thread_ts === "string" ? { threadTs: source.thread_ts } : {}),
          ...(typeof edited === "string" ? { editedTs: edited } : {}),
        },
      ];
    });
    return {
      channelId,
      messages,
      ...(nextCursor(page) === undefined ? {} : { nextCursor: nextCursor(page) }),
    };
  }

  private async resolvePublicChannelId(channel: string, credential: string): Promise<string> {
    const channelId = isChannelId(channel)
      ? channel
      : await this.resolveChannelId(normalizeChannelName(channel), credential);
    const info = await this.api(credential, "/conversations.info", {
      method: "GET",
      query: { channel: channelId },
    });
    const conversation = record(info.channel);
    if (conversation.is_member !== true) {
      throw new AdapterDispatchError("before_dispatch", "channel_not_joined", false);
    }
    if (
      conversation.is_private === true ||
      conversation.is_im === true ||
      conversation.is_mpim === true ||
      !channelId.startsWith("C")
    ) {
      throw new AdapterDispatchError("before_dispatch", "restricted_channel", false);
    }
    return channelId;
  }
}
