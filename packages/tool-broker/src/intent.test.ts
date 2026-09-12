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

  it("binds the File Principal into the intent digest", () => {
    expect(intentDigest(normalizeToolIntent(intent("principal-1")))).not.toBe(
      intentDigest(normalizeToolIntent(intent("principal-2")))
    );
  });

  it("refuses an empty File Principal", () => {
    expect(() => normalizeToolIntent(intent(""))).toThrow("invalid_intent");
  });
});
