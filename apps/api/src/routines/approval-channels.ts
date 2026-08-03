import { randomUUID } from "node:crypto";
import type { ApprovalsRepo } from "../approvals/runtime-repo";
import type { ToolRegistry } from "../broker/tool-adapter";
import { ROUTINE_ACTOR } from "./headless-turn";
import type { ApprovalRequester } from "./run-executor";

/** Routine approvals wait for humans — give them days, not the tool-call 5 minutes. */
export const ROUTINE_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ChannelLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

export interface ApprovalChannelDeps {
  approvals: ApprovalsRepo;
  /** Used to find an installed Slack send tool (integration tier). */
  toolRegistry?: ToolRegistry;
  /** Base URL for the decide link included in channel messages. */
  publicUrl?: string;
  log: ChannelLogger;
}

/** Payload stored on a `routine_state` approval row (read by the approvals list/UI). */
export interface RoutineApprovalPayload {
  routineSlug: string;
  runId: string;
  stateName: string;
  channels: string[];
  summary: Record<string, unknown>;
}

/**
 * ApprovalRequester for human_approval states (ROUT-V1-006): inserts the
 * `routine_state` approvals row (`ui` channel — always available), then best-effort
 * delivers to declared extra channels. Slack "present" ⇔ an installed integration
 * exposes an integration-tier send-message tool whose name mentions slack + send
 * (review C2 contract). `email`/`sms` are schema-accepted but unimplemented — warn and
 * fall back to ui. Channel delivery failures never block the approval itself.
 */
export function makeApprovalRequester(deps: ApprovalChannelDeps): ApprovalRequester {
  return async (run, request) => {
    const approvalId = randomUUID();
    const payload: RoutineApprovalPayload = {
      routineSlug: run.routineSlug,
      runId: run.id,
      stateName: request.stateName,
      channels: request.channels,
      summary: request.summary,
    };
    await deps.approvals.insert({
      id: approvalId,
      kind: "routine_state",
      payload,
      expiresAt: new Date(Date.now() + ROUTINE_APPROVAL_TTL_MS),
    });

    for (const channel of request.channels) {
      if (channel === "ui") continue; // the DB row IS the ui channel
      if (channel === "slack") {
        await deliverSlack(deps, approvalId, payload);
      } else {
        deps.log.warn(
          { channel, approvalId },
          `approval channel "${channel}" unavailable in V1, falling back to ui`
        );
      }
    }
    return approvalId;
  };
}

async function deliverSlack(
  deps: ApprovalChannelDeps,
  approvalId: string,
  payload: RoutineApprovalPayload
): Promise<void> {
  const sendTool = deps.toolRegistry
    ?.getAll()
    .find(
      (t) => t.tier === "integration" && /slack/i.test(t.name) && /send|post|message/i.test(t.name)
    );
  if (!sendTool) {
    deps.log.warn(
      { approvalId },
      "slack approval channel requested but no Slack send tool is installed; falling back to ui"
    );
    return;
  }
  const decideUrl = deps.publicUrl
    ? `${deps.publicUrl.replace(/\/$/, "")}/approvals`
    : "/approvals";
  const text = [
    `Approval needed: routine "${payload.routineSlug}" is waiting at state "${payload.stateName}".`,
    `Run: ${payload.runId}`,
    `Decide: ${decideUrl} (approval ${approvalId})`,
  ].join("\n");
  try {
    const result = await sendTool.execute({ text }, { userId: ROUTINE_ACTOR, autonomy: "full" });
    if (!result.success) {
      deps.log.warn(
        { approvalId, error: result.error },
        "slack approval delivery failed; ui channel remains"
      );
    }
  } catch (err) {
    deps.log.warn({ approvalId, err }, "slack approval delivery threw; ui channel remains");
  }
}
