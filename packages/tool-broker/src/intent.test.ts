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

describe("ToolIntent file Principal binding", () => {
  it("normalizes and freezes the File Principal", () => {
    expect(normalizeToolIntent(intent("principal-1"))).toMatchObject({
      filePrincipalId: "principal-1",
    });
  });

  describe("ToolIntent OIM binding", () => {
    const connection = {
      connectionId: "connection-1",
      integrationId: "acme",
      integrationMajorVersion: 2,
      operationId: "send-message",
      credentialSlot: "access_token",
      credentialRevision: "revision-1",
      identityMode: "shared_or_personal" as const,
      principalKind: "user",
      principalId: "user-1",
      manifestDigest: "sha256:manifest",
      configurationDigest: "sha256:configuration",
    };

    function connected(overrides: Record<string, unknown> = {}) {
      return {
        ...intent("user-1"),
        destination: "https://tenant.acme.example",
        credentialRef: "secret://credential-1",
        connection,
        fileIds: ["file-1", "file-2"],
        agentPrincipalId: "agent-1",
        ...overrides,
      };
    }

    it("normalizes and freezes the exact Connection binding", () => {
      expect(normalizeToolIntent(connected())).toMatchObject({
        connection,
        fileIds: ["file-1", "file-2"],
        agentPrincipalId: "agent-1",
      });
    });

    it("matches the authoritative Approval digest for every populated OIM binding", () => {
      const populated = normalizeToolIntent(
        connected({
          runStateId: "run-state-1",
          targetRefs: [
            { type: "message", id: "message-1" },
            { type: "workspace", id: "workspace-1", domain: "tenant.acme.example" },
          ],
          principalKind: "user",
          principalId: "user-1",
          activeSkillName: "support",
          integrationId: "acme",
          integrationMajorVersion: 2,
          operationId: "send-message",
          manifestDigest: "sha256:manifest",
          configurationDigest: "sha256:configuration",
          secondaryCredentialRef: "secret://credential-2",
          secondaryConnection: {
            ...connection,
            connectionId: "connection-2",
            credentialSlot: "refresh_token",
            credentialRevision: "revision-2",
          },
        })
      );

      expect(intentDigest(populated)).toBe(approvalIntentDigest(populated));
      expect(
        approvalIntentDigest({
          ...populated,
          targetRefs: populated.targetRefs.map((ref) => ({
            ...ref,
            domain: ref.domain,
          })),
        })
      ).toBe(intentDigest(populated));
      expect(
        intentDigest({
          ...populated,
          targetRefs: [...populated.targetRefs].reverse(),
        })
      ).not.toBe(intentDigest(populated));
    });

    it.each([
      ["Connection", { connection: { ...connection, connectionId: "connection-2" } }],
      ["Integration major", { connection: { ...connection, integrationMajorVersion: 3 } }],
      ["operation", { connection: { ...connection, operationId: "delete-message" } }],
      ["manifest", { connection: { ...connection, manifestDigest: "sha256:other-manifest" } }],
      [
        "configuration",
        { connection: { ...connection, configurationDigest: "sha256:other-configuration" } },
      ],
      ["destination", { destination: "https://other.acme.example" }],
      ["File IDs", { fileIds: ["file-1", "file-3"] }],
      ["Agent Principal", { agentPrincipalId: "agent-2" }],
    ])("binds the %s into the intent digest", (_label, patch) => {
      expect(intentDigest(normalizeToolIntent(connected()))).not.toBe(
        intentDigest(normalizeToolIntent(connected(patch)))
      );
    });

    it("refuses a Connection binding without a revision-pinned Secret reference", () => {
      expect(() => normalizeToolIntent(connected({ credentialRef: undefined }))).toThrow(
        "invalid_intent"
      );
    });

    it("refuses unsorted or duplicate File IDs", () => {
      expect(() =>
        normalizeToolIntent(connected({ fileIds: ["file-2", "file-1", "file-1"] }))
      ).toThrow("invalid_intent");
    });
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
