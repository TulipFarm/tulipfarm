import type { AuthorityLayer } from "@tulipfarm/authz";
import { describe, expect, it, vi } from "vitest";
import { createOimFileHost } from "./oim-file-host";

vi.mock("@tulipfarm/soul", () => ({}));

const ALLOW: AuthorityLayer = {
  name: "allow",
  grants: [{ action: "*", resourceType: "*", effect: "allow" }],
};
const DENY: AuthorityLayer = { name: "deny", grants: [] };

function hostWith(
  runSubject = { kind: "user", id: "user-owner" },
  callerLayer: AuthorityLayer | (() => AuthorityLayer) = ALLOW,
  agentLayer: AuthorityLayer | (() => AuthorityLayer) = ALLOW
) {
  return createOimFileHost({
    files: {
      async content() {
        throw new Error("not used");
      },
      async upload() {
        throw new Error("not used");
      },
    },
    runAuthority: {
      async authority() {
        return { businessId: INPUT.businessId, runId: INPUT.runId, subject: runSubject };
      },
    },
    authorityLayers: {
      async resolvePrincipalLayer() {
        return typeof callerLayer === "function" ? callerLayer() : callerLayer;
      },
      async resolveAgentLayer() {
        return typeof agentLayer === "function" ? agentLayer() : agentLayer;
      },
    },
  });
}

const INPUT = {
  businessId: "default",
  runId: "run-1",
  stateId: "state-1",
  caller: { kind: "user", id: "user-owner" },
  agentPrincipalId: "agent-1",
  fileIds: ["file-1"],
} as const;

function request(
  fileIds: readonly string[] = INPUT.fileIds,
  filePrincipalId: string = INPUT.caller.id
) {
  return {
    idempotencyKey: "dispatch-1",
    attempt: 1,
    intent: {
      intentId: "intent-1",
      businessId: INPUT.businessId,
      runId: INPUT.runId,
      stateId: INPUT.stateId,
      toolId: "github.upload_attachment",
      toolVersion: "1.0.0",
      action: "file.read",
      targetRefs: fileIds.map((id) => ({ type: "platform.file", id })),
      arguments: {},
      filePrincipalId,
      fileIds,
      agentPrincipalId: INPUT.agentPrincipalId,
      principalKind: INPUT.caller.kind,
      principalId: INPUT.caller.id,
      idempotencyKey: "dispatch-1",
    },
  } as const;
}

describe("OIM File authorization host", () => {
  it("refuses a File read when the live Run subject differs from the bound caller", async () => {
    const host = hostWith({ kind: "user", id: "another-user" });

    await expect(host.authorizeFiles(INPUT)).rejects.toThrow("File access is not authorized");
  });

  it("refuses a File read after the bound Run stops being active", async () => {
    const host = createOimFileHost({
      files: {
        async content() {
          throw new Error("not used");
        },
        async upload() {
          throw new Error("not used");
        },
      },
      runAuthority: {
        async authority() {
          throw new Error("run_not_running");
        },
      },
      authorityLayers: {
        async resolvePrincipalLayer() {
          return ALLOW;
        },
        async resolveAgentLayer() {
          return ALLOW;
        },
      },
    });

    await expect(host.authorizeFiles(INPUT)).rejects.toThrow("File access is not authorized");
  });

  it("refuses a File read after the caller's live authority is revoked", async () => {
    const host = hostWith(undefined, DENY, ALLOW);

    await expect(host.authorizeFiles(INPUT)).rejects.toThrow("File access is not authorized");
  });

  it("refuses a File read when the acting Agent lacks live authority", async () => {
    const host = hostWith(undefined, ALLOW, DENY);

    await expect(host.authorizeFiles(INPUT)).rejects.toThrow("File access is not authorized");
  });

  it("requires live authority for every exact File record", async () => {
    const host = hostWith(undefined, {
      name: "caller",
      grants: [
        {
          action: "file.read",
          resourceType: "platform.file",
          recordSelector: "file-1",
          dataClass: "operational",
          effect: "allow",
        },
      ],
    });

    await expect(host.authorizeFiles({ ...INPUT, fileIds: ["file-1", "file-2"] })).rejects.toThrow(
      "File access is not authorized"
    );
  });

  it("refuses dispatch when the requested File IDs differ from the confirmed intent", async () => {
    const host = hostWith();

    await expect(
      host.fileReadAuthorization.assertAuthorized({
        request: request(),
        fileIds: ["file-2"],
      })
    ).rejects.toThrow("File access is not authorized");
  });

  it("rechecks live authority immediately before File content access", async () => {
    let callerLayer = ALLOW;
    const host = hostWith(undefined, () => callerLayer, ALLOW);

    await expect(host.authorizeFiles(INPUT)).resolves.toBeUndefined();
    callerLayer = DENY;
    await expect(
      host.fileReadAuthorization.assertAuthorized({
        request: request(),
        fileIds: INPUT.fileIds,
      })
    ).rejects.toThrow("File access is not authorized");
  });

  it("never substitutes another owner for a missing File Principal binding", async () => {
    const host = hostWith();

    await expect(
      host.fileReadAuthorization.assertAuthorized({
        request: request(INPUT.fileIds, ""),
        fileIds: INPUT.fileIds,
      })
    ).rejects.toThrow("File access is not authorized");
  });
});
