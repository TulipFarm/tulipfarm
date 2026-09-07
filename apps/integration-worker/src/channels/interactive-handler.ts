import {
  type ChannelIdentityPort,
  ChannelRouteDeniedError,
  type ChannelRoutingSource,
  type ChannelRunStarter,
  type IntegrationHttpPort,
  resolveChannelRoute,
} from "@tulipfarm/integrations";
import { type InternalApiClient, InternalApiError } from "../internal/client";

type Decision = "approved" | "denied";

export const HANDLED_SLACK_SHORTCUT_CALLBACKS = [] as const;

interface BlockActionsPayload {
  type?: unknown;
  user?: { id?: unknown };
  team?: { id?: unknown };
  enterprise?: { id?: unknown };
  actions?: Array<{
    type?: unknown;
    action_id?: unknown;
    value?: unknown;
    selected_option?: { value?: unknown };
    selected_options?: Array<{ value?: unknown }>;
    selected_date?: unknown;
    selected_time?: unknown;
    selected_date_time?: unknown;
    selected_user?: unknown;
    selected_channel?: unknown;
    selected_conversation?: unknown;
  }>;
  channel?: { id?: unknown };
  message?: { ts?: unknown };
}

interface DecideResponse {
  outcome: "resumed" | "already_settled" | "forbidden" | "not_found" | "unlinked";
}

interface SurfaceInteractionSuccess {
  id: string;
  artifactId: string;
  revision: number;
  event: string;
  input: Record<string, unknown>;
  principal: string;
  target: { channel: string; surface: string };
  destination: string;
  occurredAt: string;
}

interface SlackViewPayload {
  type?: unknown;
  user?: { id?: unknown };
  team?: { id?: unknown };
  enterprise?: { id?: unknown };
  view?: {
    callback_id?: unknown;
    private_metadata?: unknown;
    state?: { values?: unknown };
  };
}

interface SlackSuggestionPayload {
  type?: unknown;
  user?: { id?: unknown };
  action_id?: unknown;
  value?: unknown;
}

interface SlackCommandPayload {
  command?: unknown;
  user_id?: unknown;
  channel_id?: unknown;
  team_id?: unknown;
  api_app_id?: unknown;
  trigger_id?: unknown;
  response_url?: unknown;
  text?: unknown;
}

export type SlackResponseAcknowledgement =
  | Record<string, never>
  | { response_action: "errors"; errors: Readonly<Record<string, string>> }
  | { options: readonly never[] };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackTenantId(payload: {
  team?: { id?: unknown };
  enterprise?: { id?: unknown };
}): string | undefined {
  return optionalString(payload.team?.id) ?? optionalString(payload.enterprise?.id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function selectedValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((option) =>
      option !== null && typeof option === "object"
        ? stringValue((option as { value?: unknown }).value)
        : undefined
    )
    .filter((option): option is string => option !== undefined);
  return values.length === value.length ? values : undefined;
}

function selectedDateTime(value: unknown): string | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1_000).toISOString();
}

function surfaceInputFor(
  action: NonNullable<BlockActionsPayload["actions"]>[number]
): Record<string, unknown> {
  const multi = selectedValues(action.selected_options);
  if (multi !== undefined) return { values: multi };
  const option = stringValue(action.selected_option?.value);
  if (option !== undefined) return { value: option };
  const selected =
    stringValue(action.selected_date) ??
    stringValue(action.selected_time) ??
    stringValue(action.selected_user) ??
    stringValue(action.selected_channel) ??
    stringValue(action.selected_conversation);
  if (selected !== undefined) return { value: selected };
  const dateTime = selectedDateTime(action.selected_date_time);
  if (dateTime !== undefined) return { value: dateTime };
  if (
    typeof action.type === "string" &&
    ["plain_text_input", "email_text_input", "number_input", "url_text_input"].includes(action.type)
  ) {
    const value = stringValue(action.value);
    if (value !== undefined) return { value };
  }
  return {};
}

function surfaceHandle(view: SlackViewPayload["view"]): string | undefined {
  const callbackId = optionalString(view?.callback_id);
  if (callbackId?.startsWith("sf_") === true) return callbackId;
  const metadata = optionalString(view?.private_metadata);
  if (metadata?.startsWith("sf_") === true) return metadata;
  if (metadata === undefined) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { handle?: unknown };
    const handle = optionalString(parsed.handle);
    return handle?.startsWith("sf_") === true ? handle : undefined;
  } catch {
    return undefined;
  }
}

function stateValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (state.type === "rich_text_input") return richTextValue(state.rich_text_value);
  const multi =
    selectedValues(state.selected_options) ??
    (Array.isArray(state.selected_users)
      ? state.selected_users.filter((item): item is string => typeof item === "string")
      : undefined) ??
    (Array.isArray(state.selected_channels)
      ? state.selected_channels.filter((item): item is string => typeof item === "string")
      : undefined) ??
    (Array.isArray(state.selected_conversations)
      ? state.selected_conversations.filter((item): item is string => typeof item === "string")
      : undefined);
  if (multi !== undefined) return multi;
  const selected =
    stringValue(state.value) ??
    stringValue((state.selected_option as { value?: unknown } | undefined)?.value) ??
    stringValue(state.selected_date) ??
    stringValue(state.selected_time) ??
    stringValue(state.selected_user) ??
    stringValue(state.selected_channel) ??
    stringValue(state.selected_conversation);
  if (selected !== undefined) return selected;
  return selectedDateTime(state.selected_date_time);
}

function richTextValue(value: unknown): string | undefined {
  const parts: string[] = [];
  let visited = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || visited >= 500 || parts.join("").length >= 3_000) return;
    visited += 1;
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
    else if (record.type === "emoji" && typeof record.name === "string") {
      parts.push(`:${record.name}:`);
    } else if (record.type === "user" && typeof record.user_id === "string") {
      parts.push(`<@${record.user_id}>`);
    } else if (record.type === "channel" && typeof record.channel_id === "string") {
      parts.push(`<#${record.channel_id}>`);
    } else if (record.type === "link" && typeof record.url === "string") {
      parts.push(record.url);
    }
    if (Array.isArray(record.elements)) {
      for (const child of record.elements) visit(child, depth + 1);
      if (depth === 1) parts.push("\n");
    }
  };
  visit(value, 0);
  const result = parts.join("").trimEnd().slice(0, 3_000);
  return result.length > 0 ? result : undefined;
}

function formInput(values: unknown): {
  input: Record<string, unknown>;
  errors: Record<string, string>;
} {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return { input: {}, errors: {} };
  }
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [blockId, rawActions] of Object.entries(values)) {
    if (rawActions === null || typeof rawActions !== "object" || Array.isArray(rawActions))
      continue;
    const actions = Object.values(rawActions);
    if (actions.length !== 1) continue;
    const action = actions[0];
    if (
      action !== null &&
      typeof action === "object" &&
      !Array.isArray(action) &&
      (action as { type?: unknown }).type === "file_input"
    ) {
      errors[blockId] =
        "Slack file uploads cannot be submitted here yet. Choose an existing TulipFarm File.";
      continue;
    }
    const decoded = stateValue(action);
    if (decoded !== undefined) input[blockId] = decoded;
  }
  return { input, errors };
}

function safeFieldErrors(error: unknown, fieldIds: readonly string[]): Record<string, string> {
  if (!(error instanceof InternalApiError) || error.status !== 400) return {};
  try {
    const body = JSON.parse(error.detail) as { errors?: unknown };
    if (body.errors !== null && typeof body.errors === "object" && !Array.isArray(body.errors)) {
      const errors = Object.fromEntries(
        Object.entries(body.errors as Record<string, unknown>)
          .filter(
            (entry): entry is [string, string] =>
              fieldIds.includes(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0
          )
          .map(([key, message]) => [key, message.slice(0, 200)])
      );
      if (Object.keys(errors).length > 0) return errors;
    }
  } catch {
    return {};
  }
  const firstField = fieldIds[0];
  return firstField === undefined
    ? {}
    : { [firstField]: "This form could not be submitted. Please review it and try again." };
}

function surfaceInteractionErrorCode(error: unknown): string | undefined {
  if (!(error instanceof InternalApiError) || error.status !== 400) return undefined;
  try {
    const body = JSON.parse(error.detail) as { code?: unknown };
    return optionalString(body.code);
  } catch {
    return undefined;
  }
}

function isSurfaceInteractionSuccess(value: unknown): value is SurfaceInteractionSuccess {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const target = response.target;
  return (
    typeof response.id === "string" &&
    response.id.length > 0 &&
    typeof response.artifactId === "string" &&
    response.artifactId.length > 0 &&
    Number.isInteger(response.revision) &&
    (response.revision as number) >= 1 &&
    typeof response.event === "string" &&
    response.event.length > 0 &&
    response.input !== null &&
    typeof response.input === "object" &&
    !Array.isArray(response.input) &&
    typeof response.principal === "string" &&
    response.principal.length > 0 &&
    target !== null &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    typeof (target as Record<string, unknown>).channel === "string" &&
    typeof (target as Record<string, unknown>).surface === "string" &&
    typeof response.destination === "string" &&
    response.destination.length > 0 &&
    typeof response.occurredAt === "string" &&
    Number.isFinite(Date.parse(response.occurredAt))
  );
}

const SAFE_SURFACE_REJECTION_CODES = new Set([
  "expired",
  "guardrail_changed",
  "invalid_input",
  "not_found",
  "step_up_required",
  "wrong_principal",
]);

function parseActionValue(value: unknown): { approvalId: string; decision: Decision } | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: { approvalId?: unknown; decision?: unknown };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    // A malformed action payload is not a decodable approval decision.
    return undefined;
  }
  if (typeof parsed.approvalId !== "string") return undefined;
  if (parsed.decision !== "approved" && parsed.decision !== "denied") return undefined;
  return { approvalId: parsed.approvalId, decision: parsed.decision };
}

const DECISION_LABEL: Record<Decision, string> = {
  approved: "Approved",
  denied: "Denied",
};

export interface InteractiveHandlerDeps {
  provider: string;
  internalApi: InternalApiClient;
  followUpInternalApi?: InternalApiClient;
  http: IntegrationHttpPort;
  credential: string;
  log: { warn: (message: string, error?: unknown) => void };
}

export interface SlackCommandHandlerDeps extends InteractiveHandlerDeps {
  businessId: string;
  identities: ChannelIdentityPort;
  routing: ChannelRoutingSource;
  runs: ChannelRunStarter;
}

export type SlackDeferredWork = () => Promise<void>;

export interface SlackResponseReservation {
  readonly acknowledgement: SlackResponseAcknowledgement;
  readonly followUp?: SlackDeferredWork;
}

type SlackCommandResponse = "starting" | "unlinked" | "denied" | "prompt_unavailable";

function processSurfaceInteraction(
  interactionId: string,
  deps: Pick<InteractiveHandlerDeps, "internalApi" | "followUpInternalApi">
): Promise<unknown> {
  return (deps.followUpInternalApi ?? deps.internalApi).require(
    "POST",
    `/api/v1/internal/surfaces/interactions/${interactionId}/process`
  );
}

function isSlackCommandResponseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" || url.hostname === "hooks.slack-gov.com") &&
      url.pathname.startsWith("/commands/") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

async function reserveSlackCommandResponse(
  input: {
    externalTenantId: string;
    triggerId: string;
    responseUrl: string;
    response: SlackCommandResponse;
  },
  deps: Pick<InteractiveHandlerDeps, "internalApi" | "followUpInternalApi">
): Promise<SlackDeferredWork> {
  const idempotencyKey = `slack-command-response:${input.externalTenantId}:${input.triggerId}`;
  await deps.internalApi.require("POST", "/api/v1/internal/channels/slack/command-responses", {
    idempotencyKey,
    responseUrl: input.responseUrl,
    response: input.response,
  });
  return () =>
    (deps.followUpInternalApi ?? deps.internalApi)
      .require(
        "POST",
        `/api/v1/internal/channels/slack/command-responses/process?idempotencyKey=${encodeURIComponent(idempotencyKey)}`
      )
      .then(() => undefined);
}

/** Commits the idempotent interaction before returning any provider follow-up work. */
export async function reserveSlackInteractive(
  payload: unknown,
  deps: InteractiveHandlerDeps
): Promise<SlackDeferredWork | undefined> {
  const body = payload as BlockActionsPayload;
  if (body.type === "view_closed" || body.type === "shortcut" || body.type === "message_action") {
    return undefined;
  }
  if (body.type !== "block_actions") return undefined;

  const userId = typeof body.user?.id === "string" ? body.user.id : undefined;
  const externalTenantId = slackTenantId(body);
  if (userId === undefined || externalTenantId === undefined) return undefined;

  const action = body.actions?.[0];
  const actionId = typeof action?.action_id === "string" ? action.action_id : undefined;
  if (actionId?.startsWith("sf_") === true) {
    let response: unknown;
    try {
      response = await deps.internalApi.require<unknown>(
        "POST",
        "/api/v1/internal/surfaces/interactions",
        {
          handle: actionId,
          provider: deps.provider,
          externalSubject: userId,
          externalTenantId,
          input: surfaceInputFor(action ?? {}),
        }
      );
    } catch (error) {
      if (surfaceInteractionErrorCode(error) !== "replayed") throw error;
      return undefined;
    }
    if (!isSurfaceInteractionSuccess(response)) {
      throw new Error("slack_surface_interaction_unknown_result");
    }
    return () => processSurfaceInteraction(response.id, deps).then(() => undefined);
  }

  const parsed = parseActionValue(action?.value);
  if (parsed === undefined) return undefined;

  const response = await deps.internalApi.require<DecideResponse>(
    "POST",
    `/api/v1/internal/channels/approvals/${parsed.approvalId}/decide`,
    {
      provider: deps.provider,
      externalSubject: userId,
      externalTenantId,
      decision: parsed.decision,
    }
  );
  const outcome = response.outcome;

  const channelId = typeof body.channel?.id === "string" ? body.channel.id : undefined;
  const ts = typeof body.message?.ts === "string" ? body.message.ts : undefined;
  if (channelId === undefined || ts === undefined || outcome === "already_settled") {
    return undefined;
  }

  const text =
    outcome === "resumed"
      ? `${DECISION_LABEL[parsed.decision]} by <@${userId}>`
      : outcome === "unlinked"
        ? "This Slack account isn't linked to a Tulip user — approval not recorded."
        : "This approval was already resolved.";

  return async () => {
    try {
      await deps.http.send(
        { method: "POST", path: "/chat.update", body: { channel: channelId, ts, text } },
        deps.credential
      );
    } catch (error) {
      deps.log.warn("slack approval status update failed", error);
    }
  };
}

export async function handleSlackInteractive(
  payload: unknown,
  deps: InteractiveHandlerDeps
): Promise<void> {
  try {
    await (await reserveSlackInteractive(payload, deps))?.();
  } catch (error) {
    deps.log.warn("slack interactive handling failed", error);
  }
}

export async function reserveSlackResponseInteractive(
  payload: unknown,
  deps: InteractiveHandlerDeps
): Promise<SlackResponseReservation> {
  const suggestion = payload as SlackSuggestionPayload;
  if (suggestion.type === "block_suggestion") return { acknowledgement: { options: [] } };

  const body = payload as SlackViewPayload;
  if (body.type !== "view_submission") return { acknowledgement: {} };
  const userId = optionalString(body.user?.id);
  const externalTenantId = slackTenantId(body);
  const handle = surfaceHandle(body.view);
  const decoded = formInput(body.view?.state?.values);
  const { input } = decoded;
  const fieldIds = Object.keys(input);
  if (Object.keys(decoded.errors).length > 0) {
    return { acknowledgement: { response_action: "errors", errors: decoded.errors } };
  }
  if (userId === undefined || externalTenantId === undefined || handle === undefined) {
    const firstField = fieldIds[0];
    return {
      acknowledgement:
        firstField === undefined
          ? {}
          : {
              response_action: "errors",
              errors: { [firstField]: "This form is no longer available. Please reopen it." },
            },
    };
  }

  try {
    const response = await deps.internalApi.require<unknown>(
      "POST",
      "/api/v1/internal/surfaces/interactions",
      {
        handle,
        provider: deps.provider,
        externalSubject: userId,
        externalTenantId,
        input,
      }
    );
    if (!isSurfaceInteractionSuccess(response)) {
      throw new Error("slack_surface_interaction_unknown_result");
    }
    return {
      acknowledgement: {},
      followUp: () => processSurfaceInteraction(response.id, deps).then(() => undefined),
    };
  } catch (error) {
    deps.log.warn("slack surface form submission failed", error);
    const code = surfaceInteractionErrorCode(error);
    if (code === "replayed") return { acknowledgement: {} };
    if (code === undefined || !SAFE_SURFACE_REJECTION_CODES.has(code)) throw error;
    const errors = safeFieldErrors(error, fieldIds);
    return {
      acknowledgement:
        Object.keys(errors).length === 0 ? {} : { response_action: "errors", errors },
    };
  }
}

export async function handleSlackResponseInteractive(
  payload: unknown,
  deps: InteractiveHandlerDeps
): Promise<SlackResponseAcknowledgement> {
  return (await reserveSlackResponseInteractive(payload, deps)).acknowledgement;
}

export async function reserveSlackSlashCommand(
  payload: unknown,
  _envelopeId: string,
  deps: SlackCommandHandlerDeps
): Promise<SlackDeferredWork | undefined> {
  const body = payload as SlackCommandPayload;
  const userId = optionalString(body.user_id);
  const channelId = optionalString(body.channel_id);
  const externalTenantId = optionalString(body.team_id);
  const externalAppId = optionalString(body.api_app_id);
  const triggerId = optionalString(body.trigger_id);
  const responseUrl = optionalString(body.response_url);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (
    body.command !== "/tulipfarm" ||
    userId === undefined ||
    channelId === undefined ||
    externalTenantId === undefined ||
    externalAppId === undefined ||
    triggerId === undefined ||
    responseUrl === undefined ||
    !isSlackCommandResponseUrl(responseUrl)
  ) {
    return undefined;
  }
  if (text.length === 0) {
    return reserveSlackCommandResponse(
      { externalTenantId, triggerId, responseUrl, response: "prompt_unavailable" },
      deps
    );
  }

  try {
    const principal = await deps.identities.resolve({
      businessId: deps.businessId,
      provider: deps.provider,
      externalSubject: userId,
      externalTenantId,
    });
    if (principal === undefined) {
      return reserveSlackCommandResponse(
        { externalTenantId, triggerId, responseUrl, response: "unlinked" },
        deps
      );
    }
    const snapshot = await deps.routing.load({
      businessId: deps.businessId,
      provider: deps.provider,
      externalTenantId,
    });
    const route = resolveChannelRoute(snapshot, {
      businessId: deps.businessId,
      provider: deps.provider,
      externalTenantId,
      externalAppId,
      channelId,
      eventType: "message",
      principal,
      action: "channels.message.receive",
      targetType: "slack.channel",
    });
    await deps.runs.start({
      businessId: deps.businessId,
      eventId: `slack-command:${externalTenantId}:${triggerId}`,
      integrationId: route.integrationId,
      routeId: route.routeId,
      agentId: route.agentId,
      principal,
      message: { externalAppId, channelId, text, media: [] },
    });
    return reserveSlackCommandResponse(
      { externalTenantId, triggerId, responseUrl, response: "starting" },
      deps
    );
  } catch (error) {
    if (!(error instanceof ChannelRouteDeniedError)) throw error;
    return reserveSlackCommandResponse(
      { externalTenantId, triggerId, responseUrl, response: "denied" },
      deps
    );
  }
}

export async function handleSlackSlashCommand(
  payload: unknown,
  envelopeId: string,
  deps: SlackCommandHandlerDeps
): Promise<void> {
  try {
    await (await reserveSlackSlashCommand(payload, envelopeId, deps))?.();
  } catch (error) {
    deps.log.warn("slack command failed", error);
  }
}
