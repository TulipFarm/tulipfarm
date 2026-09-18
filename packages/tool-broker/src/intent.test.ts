import { approvalIntentDigest } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import { intentDigest, normalizeToolIntent } from "./intent";

function intent(filePrincipalId?: string) {
  return {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: "files.upload",
    toolVersion: "1.0.0",
    action: "files.upload",
    targetRefs: [],
    arguments: { fileId: "file-1" },
    ...(filePrincipalId === undefined ? {} : { filePrincipalId }),
    idempotencyKey: "effect-1",
  };
}

describe("ToolIntent MCP binding", () => {
  const binding = {
    serverId: "github",
    serverRevision: "a".repeat(64),
    accountId: "account-1",
    accountRevision: "1",
    subjectId: "user-1",
    authorizationId: "routine-approval-1",
  };

  it("validates and freezes the complete account and authorization binding", () => {
    const normalized = normalizeToolIntent({ ...intent(), mcp: binding });
    expect(normalized.mcp).toEqual(binding);
    expect(Object.isFrozen(normalized.mcp)).toBe(true);
    expect(() => normalizeToolIntent({ ...intent(), mcp: { serverId: "github" } })).toThrow(
      "invalid_intent"
    );
  });

  it.each([
    { serverId: "other" },
    { serverRevision: "b".repeat(64) },
    { accountId: "account-2" },
    { accountRevision: "2" },
    { subjectId: "user-2" },
    { authorizationId: "another-approval" },
  ])("binds every MCP dimension into the shared Approval digest: %j", (change) => {
    const original = normalizeToolIntent({ ...intent(), mcp: binding });
    const changed = normalizeToolIntent({ ...intent(), mcp: { ...binding, ...change } });
    expect(intentDigest(original)).toBe(approvalIntentDigest(original));
    expect(intentDigest(changed)).not.toBe(intentDigest(original));
    expect(intentDigest(original)).not.toBe(intentDigest(normalizeToolIntent(intent())));
  });

  it("rejects a second credential mechanism alongside an MCP account binding", () => {
    expect(() =>
      normalizeToolIntent({ ...intent(), mcp: binding, credentialRef: "secret://another" })
    ).toThrow("invalid_intent");
  });

  it.each([
    "integrationId",
    "integrationMajorVersion",
    "operationId",
    "manifestDigest",
    "configurationDigest",
    "connection",
    "secondaryCredentialRef",
    "secondaryConnection",
  ])("rejects retired authority instead of silently discarding %s", (field) => {
    for (const mcp of [undefined, binding]) {
      expect(() => normalizeToolIntent({ ...intent(), mcp, [field]: "retired-authority" })).toThrow(
        "invalid_intent"
      );
    }
  });

  it("matches the authoritative Approval digest with all surviving authority populated", () => {
    const populated = normalizeToolIntent({
      ...intent("user-1"),
      mcp: binding,
      runStateId: "run-state-1",
      targetRefs: [
        { type: "message", id: "message-1" },
        { type: "workspace", id: "workspace-1", domain: "tenant.example.com" },
      ],
      principalKind: "user",
      principalId: "user-1",
      activeSkillName: "support",
      destination: "https://mcp.example.com",
      fileIds: ["file-1", "file-2"],
      agentPrincipalId: "agent-1",
    });
    expect(intentDigest(populated)).toBe(approvalIntentDigest(populated));
    expect(
      approvalIntentDigest({
        ...populated,
        targetRefs: populated.targetRefs.map((ref) => ({ ...ref, domain: ref.domain })),
      })
    ).toBe(intentDigest(populated));
    expect(
      intentDigest({ ...populated, targetRefs: [...populated.targetRefs].reverse() })
    ).not.toBe(intentDigest(populated));
  });
});

describe("ToolIntent file Principal binding", () => {
  it("normalizes and freezes the File Principal", () => {
    expect(normalizeToolIntent(intent("principal-1"))).toMatchObject({
      filePrincipalId: "principal-1",
    });
  });

  it.each([
    ["destination", { destination: "https://other.example.com" }],
    ["File IDs", { fileIds: ["file-1", "file-3"] }],
    ["Agent Principal", { agentPrincipalId: "agent-2" }],
  ])("binds the %s into the intent digest", (_label, patch) => {
    const original = {
      ...intent("user-1"),
      destination: "https://example.com",
      fileIds: ["file-1", "file-2"],
      agentPrincipalId: "agent-1",
    };
    expect(intentDigest(normalizeToolIntent(original))).not.toBe(
      intentDigest(normalizeToolIntent({ ...original, ...patch }))
    );
  });

  it.each([
    ["file-2", "file-1"],
    ["file-1", "file-1"],
  ])("refuses unsorted or duplicate File IDs: %j", (...fileIds) => {
    expect(() => normalizeToolIntent({ ...intent(), fileIds })).toThrow("invalid_intent");
  });

  it("binds the File Principal into the intent digest", () => {
    expect(intentDigest(normalizeToolIntent(intent("principal-1")))).not.toBe(
      intentDigest(normalizeToolIntent(intent("principal-2")))
    );
  });

  it("refuses an empty File Principal", () => {
    expect(() => normalizeToolIntent(intent(""))).toThrow("invalid_intent");
  });
});
