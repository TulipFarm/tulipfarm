import { createHash } from "node:crypto";
import { SLACK_TOOL_CONTRACTS, SLACK_TOOL_IDS, type SlackToolId } from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import {
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
  type ToolDef,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { IntegrationConversationsRepo } from "../../ingress/repo";
import { externalThreadKey } from "../../internal/channel-routes";
import type { SlackTooling } from "./compose";
import { SLACK_BOT_TOKEN_SECRET_REF } from "./credentials";

/** Slack Tools use the effect ledger; sent bot threads are mapped and mention-marked. */

const SLACK_CATALOG = ToolCatalog.load(SLACK_TOOL_CONTRACTS);
const SLACK_RESOURCE = "integration.slack";
const SLACK_CHANNEL_TARGET = "slack.channel";
const SLACK_UNRESOLVED_CHANNEL_NAME_TARGET = "slack.channel_name";

interface SlackToolSpec {
  readonly name: string;
  readonly description: string;
}

const SLACK_TOOL_SPECS: Record<SlackToolId, SlackToolSpec> = {
  [SLACK_TOOL_IDS.sendMessage]: {
    name: "send_slack_message",
    description:
      "Send a message to a Slack channel the bot has joined. Accepts a channel name (with or " +
      "without a leading '#') or a raw channel ID. A human reply in the resulting thread " +
      "continues this same conversation. To notify a specific person, write '@' followed by " +
      "their Slack name or first name (e.g. 'hi @mohit') — this is converted into a real, " +
      "clickable, notifying Slack mention before sending. Writing the name with no '@' sends " +
      "it as plain text and does not notify or tag anyone.",
  },
};

/** Dresses a digest as an RFC 4122 v4 uuid for durable effect ids. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError): ToolCallResult {
  if (error.code === "invalid_output")
    return err("internal_error", "Slack returned an unexpected response shape");
  if (error.detail === "channel_not_found") {
    return err("not_found", "No Slack channel by that name — check the bot has joined it.");
  }
  // Treat missing credentials as infrastructure, not model-repairable bad arguments.
  if (error.detail === "provider_rate_limited" || error.detail === "provider_unavailable") {
    return err("unavailable", "Slack is temporarily unavailable; try again shortly.");
  }
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/** Replayed effect: settled state only, no retained Slack response body. */
function replayed(state: string): ToolCallResult {
  switch (state) {
    case "confirmed":
      return ok({ replayed: true, note: "This message already sent; not repeated." });
    case "denied":
      return err("internal_error", "effect_denied");
    case "failed":
      return err("internal_error", "effect_failed");
    default:
      return err("internal_error", `effect_${state}`);
  }
}

function isSendMessageOutput(
  value: unknown
): value is { channelId: string; ts: string; threadId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).channelId === "string" &&
    typeof (value as Record<string, unknown>).ts === "string"
  );
}

/** See the note in `tools/github/tools.ts`: the gate's namespace is the declared resource. */
const SLACK_AUTHZ_RESOURCE = "integration.slack";

function slackChannelTargets(args: unknown): readonly ToolTargetRef[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const channel = (args as Record<string, unknown>).channel;
  if (typeof channel !== "string" || channel.length === 0) return [];
  const normalized = channel.trim();
  if (normalized.length === 0) return [];
  if (/^[CGD][A-Z0-9]{8,}$/.test(normalized)) {
    return [{ type: SLACK_AUTHZ_RESOURCE, id: `channel:${normalized}` }];
  }
  // Keep #name/name targets separate from stable channel ids; names need an API call to resolve.
  const name = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  return name.length === 0 ? [] : [{ type: SLACK_AUTHZ_RESOURCE, id: `channel-name:${name}` }];
}

export interface SlackToolingContext extends SlackTooling {
  readonly effects: EffectStore;
  readonly threads: IntegrationConversationsRepo;
  readonly mentionedThreads: ChannelMentionedThreadStore;
  readonly mutationGuard?: MutationGuard;
}

function buildToolDef(
  toolId: SlackToolId,
  businessId: string,
  tooling: SlackToolingContext
): ToolDef {
  const contract = SLACK_CATALOG.get(toolId, "1.0.0");
  if (contract === undefined) {
    throw new Error(`slack tool contract not published: ${toolId}`);
  }
  const spec = SLACK_TOOL_SPECS[toolId];

  const definition = defineApiTool<RequestContext>({
    name: spec.name,
    tier: "integration",
    mutating: contract.mutating,
    description: spec.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    authorization: {
      action: contract.action,
      resources: [SLACK_RESOURCE],
      targets: slackChannelTargets,
      dataClasses: contract.dataClasses,
      allowedDestinations: contract.allowedDestinations,
    },
    riskClass: contract.riskClass,
    credentialMode: "service",
    provider: "slack",
    idempotency: contract.idempotency.strategy,
    timeout: contract.timeout,
    compensation: contract.compensation,
    retry: contract.retry,
    version: contract.toolVersion,
    async handler(args, ctx): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;

      const rawIntent: ToolIntent = {
        intentId: derivedId("slack-intent", runId, stateId, toolId),
        businessId,
        runId,
        stateId,
        toolId,
        toolVersion: contract.toolVersion,
        action: toolId,
        // Build intent from `targetsFor`; the gate reads the same derivation.
        targetRefs: definition.targetsFor(args, ctx),
        arguments: args,
        credentialRef: SLACK_BOT_TOKEN_SECRET_REF,
        idempotencyKey: derivedId("slack-idempotency", runId, stateId, toolId),
      };
      const intent = normalizeToolIntent(rawIntent);
      const effectId = derivedId("slack-effect", runId, stateId, toolId);

      const reserved = await tooling.effects.reserve({
        effectId,
        businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });

      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      const dispatcher = new EffectDispatcher({
        store: tooling.effects,
        catalog: SLACK_CATALOG,
        adapters: tooling.adapters,
        credentialDispatcher: tooling.credentials,
        ...(tooling.mutationGuard === undefined
          ? {}
          : { mutationGuard: tooling.mutationGuard, mutationIdentity: { integrationId: "slack" } }),
      });

      try {
        const output = await dispatcher.dispatch(
          businessId,
          reserved.effect.effectId,
          ctx.abortSignal
        );
        if (toolId === SLACK_TOOL_IDS.sendMessage && isSendMessageOutput(output)) {
          // Bot-started threads count as mentioned for the ingress mention-gate.
          await tooling.mentionedThreads.mark({
            businessId,
            provider: "slack",
            channelId: output.channelId,
            threadId: output.threadId,
          });
          if (ctx.conversationId !== undefined) {
            const key = externalThreadKey("slack", {
              externalAppId: "",
              channelId: output.channelId,
              threadId: output.threadId,
              text: "",
            });
            await tooling.threads.insert({
              integrationSlug: "slack",
              externalKey: key,
              conversationId: ctx.conversationId,
              userId: ctx.userId,
            });
          }
        }
        return ok(output);
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error);
        throw error;
      }
    },
  });

  return toToolDef(definition, (ctx) => ctx);
}

export function buildSlackTools(businessId: string, tooling: SlackToolingContext): ToolDef[] {
  return SLACK_TOOL_CONTRACTS.map((contract) =>
    buildToolDef(contract.spec.toolId as SlackToolId, businessId, tooling)
  );
}
