import { createHash } from "node:crypto";
import { SLACK_TOOL_CONTRACTS, SLACK_TOOL_IDS, type SlackToolId } from "@tulipfarm/integrations";
import type { ChannelMentionedThreadStore } from "@tulipfarm/storage";
import {
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import type { IntegrationConversationsRepo } from "../../ingress/repo";
import { externalThreadKey } from "../../internal/channel-routes";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../types";
import type { SlackTooling } from "./compose";
import { SLACK_BOT_TOKEN_SECRET_REF } from "./credentials";

/**
 * The chat-facing Slack Tool family — one `ToolDef` per `SLACK_TOOL_CONTRACTS` entry, tier
 * `"integration"`. Mirrors `../github/tools.ts`: every call goes through the effect-ledger
 * idempotency path (`EffectStore.reserve` -> `EffectDispatcher.dispatch`). Approval gating is the
 * existing chat-turn coarse gate keyed on `ToolDef.mutating` — no bespoke Slack approval UI.
 *
 * After a successful send, writes an `integration_conversations` mapping for the sent message's
 * channel + `ts` so a human reply in that Slack thread routes back to this same conversation,
 * exactly as the reactive ingress path would derive on first inbound message
 * (`internal/channel-routes.ts`'s `externalThreadKey`). It also marks the thread as mentioned
 * (`ChannelMentionedThreadStore.mark`) — `apps/integration-worker`'s mention-gate
 * (`channels/mention-gate.ts`) only lets a channel reply through when the thread was previously
 * marked via a human `@mention`; a thread the bot itself started has no such mark, so without this
 * every reply in it would be silently dropped as `unmentioned_thread`.
 */

const SLACK_CATALOG = ToolCatalog.load(SLACK_TOOL_CONTRACTS);

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

/** Dresses a digest as an RFC 4122 v4 uuid, same technique run-kernel uses for durable effect ids. */
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
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/**
 * A rediscovered effect from an earlier attempt at this exact call (same run + call id) — the
 * ledger keeps only whether it landed, not the Slack response body, so a replay can't hand the
 * model the original output back. Mirrors `../github/tools.ts`'s `replayed()`.
 */
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

export interface SlackToolingContext extends SlackTooling {
  readonly effects: EffectStore;
  readonly threads: IntegrationConversationsRepo;
  readonly mentionedThreads: ChannelMentionedThreadStore;
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

  return {
    name: spec.name,
    tier: "integration",
    mutating: contract.mutating,
    description: spec.description,
    inputSchema: contract.inputSchema,
    async execute(args, ctx: RequestContext): Promise<ToolCallResult> {
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
        targetRefs: [],
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
      });

      try {
        const output = await dispatcher.dispatch(businessId, reserved.effect.effectId);
        if (toolId === SLACK_TOOL_IDS.sendMessage && isSendMessageOutput(output)) {
          // Let a reply in this thread pass the ingress mention-gate even though no human ever
          // @mentioned the bot here — the bot starting the thread should count the same way.
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
  };
}

export function buildSlackTools(businessId: string, tooling: SlackToolingContext): ToolDef[] {
  return SLACK_TOOL_CONTRACTS.map((contract) =>
    buildToolDef(contract.spec.toolId as SlackToolId, businessId, tooling)
  );
}

/** Every chat tool name this family registers. */
export const SLACK_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(SLACK_TOOL_SPECS).map((spec) => spec.name)
);
