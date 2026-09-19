import type { McpExecutionBinding } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { defineApiTool, toToolDef } from "./define";
import { prepareMcpToolCall } from "./mcp-preparation";
import { type ToolCallPreparationPort, ToolPreparationDeniedError } from "./ports";
import { ok } from "./types";

type Preparation = Parameters<ToolCallPreparationPort["prepare"]>[0];

function fixture() {
  const tool = toToolDef(
    defineApiTool({
      name: "mcp_example",
      tier: "integration",
      description: "Read account status",
      inputSchema: { type: "object", properties: { probe: { type: "string" } } },
      mutating: true,
      requiresApproval: true,
      authorization: {
        action: "integration.execute",
        resources: ["integration"],
        targets: () => [{ type: "integration", id: "example" }],
        dataClasses: ["source_content"],
      },
      handler: async () => ok({}),
    }),
    (context) => context
  );
  const definition = tool.definition;
  if (!definition) throw new Error("Missing fixture definition");
  const input: Preparation = {
    businessId: "business",
    runId: "run",
    stateId: "invoke",
    toolCallId: "call",
    tool,
    arguments: { probe: "status" },
    subject: { kind: "user", id: "muskan" },
    agent: { name: "assistant", principalId: "agent-1" },
    activeSkillName: "status",
  };
  const binding: McpExecutionBinding = {
    serverId: "example",
    serverRevision: "a".repeat(64),
    accountId: "personal",
    accountRevision: "1",
    subjectId: "muskan",
    authorizationId: "authorization",
  };
  return { input, definition, binding };
}

describe("MCP call preparation", () => {
  it("freezes the call and preserves its account, Run State, principal and Skill", () => {
    const { input, definition, binding } = fixture();
    const prepared = prepareMcpToolCall(input, definition, binding);
    expect(prepared.intent).toMatchObject({
      businessId: input.businessId,
      runId: input.runId,
      stateId: "chat:call",
      runStateId: "invoke",
      toolId: input.tool.name,
      toolVersion: definition.version,
      arguments: input.arguments,
      principalKind: "user",
      principalId: "muskan",
      agentPrincipalId: "agent-1",
      activeSkillName: "status",
      mcp: binding,
    });
    expect(prepared.intent.arguments).not.toBe(input.arguments);
    expect(prepared.intent.mcp).not.toBe(binding);
    expect(Object.isFrozen(prepared.intent)).toBe(true);
    expect(
      prepareMcpToolCall({ ...input, pinnedIntent: prepared.intent }, definition, binding)
    ).toEqual(prepared);
  });

  it.each<[string, Partial<Preparation>]>([
    ["business", { businessId: "another-business" }],
    ["Run", { runId: "another-run" }],
    ["Run State", { stateId: "another-state" }],
    ["call", { toolCallId: "another-call" }],
    ["arguments", { arguments: { probe: "changed" } }],
    ["principal", { subject: { kind: "user", id: "another-principal" } }],
    ["Agent", { agent: { name: "assistant", principalId: "another-agent" } }],
    ["Skill", { activeSkillName: "another-skill" }],
  ])("rejects a changed %s on approval resume", (_name, patch) => {
    const { input, definition, binding } = fixture();
    const { intent } = prepareMcpToolCall(input, definition, binding);
    expect(() =>
      prepareMcpToolCall({ ...input, ...patch, pinnedIntent: intent }, definition, binding)
    ).toThrow(ToolPreparationDeniedError);
  });

  it.each<[string, Partial<McpExecutionBinding>]>([
    ["server", { serverId: "another-server" }],
    ["server revision", { serverRevision: "b".repeat(64) }],
    ["account", { accountId: "another-account" }],
    ["account revision", { accountRevision: "2" }],
    ["subject", { subjectId: "another-subject" }],
    ["authorization", { authorizationId: "another-authorization" }],
  ])("rejects a changed %s binding on approval resume", (_name, patch) => {
    const { input, definition, binding } = fixture();
    const { intent } = prepareMcpToolCall(input, definition, binding);
    expect(() =>
      prepareMcpToolCall({ ...input, pinnedIntent: intent }, definition, { ...binding, ...patch })
    ).toThrow(ToolPreparationDeniedError);
  });

  it.each(["intentId", "runId", "stateId", "idempotencyKey"])(
    "rejects a different pinned %s even when the approval digest matches",
    (field) => {
      const { input, definition, binding } = fixture();
      const { intent } = prepareMcpToolCall(input, definition, binding);
      expect(() =>
        prepareMcpToolCall(
          { ...input, pinnedIntent: { ...intent, [field]: "changed" } },
          definition,
          binding
        )
      ).toThrow(ToolPreparationDeniedError);
    }
  );
});
