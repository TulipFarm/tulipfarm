import { createHash } from "node:crypto";
import type { McpExecutionBinding } from "@tulipfarm/schema";
import { intentDigest, normalizeToolIntent } from "@tulipfarm/tool-broker";
import { type ToolCallPreparationPort, ToolPreparationDeniedError } from "./ports";

type Preparation = Parameters<ToolCallPreparationPort["prepare"]>[0];

function uuid(...parts: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Freezes the host's call identity and authorized MCP account before one-use Approval. */
export function prepareMcpToolCall(
  input: Preparation,
  definition: NonNullable<Preparation["tool"]["definition"]>,
  binding: McpExecutionBinding
) {
  const intent = normalizeToolIntent({
    intentId: uuid("mcp-intent", input.runId, input.toolCallId, input.tool.name),
    businessId: input.businessId,
    runId: input.runId,
    stateId: `chat:${input.toolCallId}`,
    runStateId: input.stateId,
    toolId: input.tool.name,
    toolVersion: definition.version,
    action: definition.authorization.action,
    targetRefs: definition.targetsFor(input.arguments),
    arguments: input.arguments,
    principalKind: input.subject.kind,
    principalId: input.subject.id,
    ...(input.agent.principalId === undefined ? {} : { agentPrincipalId: input.agent.principalId }),
    ...(input.activeSkillName === undefined ? {} : { activeSkillName: input.activeSkillName }),
    mcp: binding,
    idempotencyKey: uuid("mcp-idempotency", input.runId, input.toolCallId, input.tool.name),
  });
  // The approval digest omits call identity; replay must bind those fields separately.
  const pinned = input.pinnedIntent;
  if (
    pinned &&
    (pinned.intentId !== intent.intentId ||
      pinned.runId !== intent.runId ||
      pinned.stateId !== intent.stateId ||
      pinned.idempotencyKey !== intent.idempotencyKey ||
      intentDigest(pinned) !== intentDigest(intent))
  ) {
    throw new ToolPreparationDeniedError(
      "The approved MCP account, capability or arguments changed."
    );
  }
  return { intent, definition };
}
