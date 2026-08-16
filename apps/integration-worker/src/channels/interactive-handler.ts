import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import type { InternalApiClient } from "../internal/client";

type Decision = "approved" | "denied";

interface BlockActionsPayload {
  type?: unknown;
  user?: { id?: unknown };
  actions?: Array<{
    action_id?: unknown;
    value?: unknown;
    selected_option?: { value?: unknown };
    selected_options?: Array<{ value?: unknown }>;
  }>;
  channel?: { id?: unknown };
  message?: { ts?: unknown };
}

interface DecideResponse {
  outcome: "resumed" | "already_settled" | "forbidden" | "not_found" | "unlinked";
}

interface SurfaceInteractionResponse {
  code?: string;
}

function surfaceInputFor(
  action: NonNullable<BlockActionsPayload["actions"]>[number]
): Record<string, unknown> {
  if (Array.isArray(action.selected_options)) {
    return { values: action.selected_options.map((option) => option.value) };
  }
  if (action.selected_option !== undefined) {
    return { value: action.selected_option.value };
  }
  return {};
}

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
  http: IntegrationHttpPort;
  credential: string;
  log: { warn: (message: string, error?: unknown) => void };
}

/** Slack already got its 3s ack; follow-up records the decision and disables repeats. */
export async function handleSlackInteractive(
  payload: unknown,
  deps: InteractiveHandlerDeps
): Promise<void> {
  const body = payload as BlockActionsPayload;
  if (body.type !== "block_actions") return;

  const userId = typeof body.user?.id === "string" ? body.user.id : undefined;
  if (userId === undefined) return;

  const action = body.actions?.[0];
  const actionId = typeof action?.action_id === "string" ? action.action_id : undefined;
  if (actionId?.startsWith("sf_") === true) {
    try {
      await deps.internalApi.require<SurfaceInteractionResponse>(
        "POST",
        "/api/v1/internal/surfaces/interactions",
        {
          handle: actionId,
          provider: deps.provider,
          externalSubject: userId,
          input: surfaceInputFor(action ?? {}),
        }
      );
    } catch (error) {
      deps.log.warn("slack surface interaction failed", error);
    }
    return;
  }

  const parsed = parseActionValue(action?.value);
  if (parsed === undefined) return;

  let outcome: DecideResponse["outcome"];
  try {
    const response = await deps.internalApi.require<DecideResponse>(
      "POST",
      `/api/v1/internal/channels/approvals/${parsed.approvalId}/decide`,
      { provider: deps.provider, externalSubject: userId, decision: parsed.decision }
    );
    outcome = response.outcome;
  } catch (error) {
    deps.log.warn("slack approval decide failed", error);
    return;
  }

  const channelId = typeof body.channel?.id === "string" ? body.channel.id : undefined;
  const ts = typeof body.message?.ts === "string" ? body.message.ts : undefined;
  if (channelId === undefined || ts === undefined) return;

  const text =
    outcome === "resumed"
      ? `${DECISION_LABEL[parsed.decision]} by <@${userId}>`
      : outcome === "unlinked"
        ? "This Slack account isn't linked to a Tulip user — approval not recorded."
        : "This approval was already resolved.";

  try {
    await deps.http.send(
      { method: "POST", path: "/chat.update", body: { channel: channelId, ts, text } },
      deps.credential
    );
  } catch (error) {
    deps.log.warn("slack approval status update failed", error);
  }
}
