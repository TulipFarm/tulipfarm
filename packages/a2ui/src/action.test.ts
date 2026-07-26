import { describe, expect, it, vi } from "vitest";
import {
  type A2UIActionDescriptor,
  A2UIActionError,
  type A2UINonceStore,
  authorizeA2UIAction,
  signA2UIAction,
} from "./action";

const descriptor: A2UIActionDescriptor = {
  version: "1",
  action: "ticket.approve",
  target: "ticket:42",
  destination: "jira:acme",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["comment"],
    properties: { comment: { type: "string", minLength: 1 } },
  },
  fields: ["comment"],
  audience: ["user:alice"],
  runId: "run-1",
  stateKey: "Approve",
  conversationId: "conversation-1",
  nonce: "nonce-1",
  guardrailRevision: "guardrail-7",
  issuedAt: "2026-07-26T00:00:00.000Z",
  expiresAt: "2026-07-26T00:05:00.000Z",
};

class OneUseNonceStore implements A2UINonceStore {
  private consumed = false;

  async consume(): Promise<boolean> {
    if (this.consumed) return false;
    this.consumed = true;
    return true;
  }
}

function authorize(overrides: Partial<Parameters<typeof authorizeA2UIAction>[0]> = {}) {
  return authorizeA2UIAction({
    token: signA2UIAction(descriptor, "test-signing-key"),
    signingKey: "test-signing-key",
    principal: "user:alice",
    input: { comment: "ship it" },
    currentGuardrailRevision: "guardrail-7",
    now: new Date("2026-07-26T00:01:00.000Z"),
    nonceStore: new OneUseNonceStore(),
    reauthenticate: async () => true,
    authorize: async (request) =>
      request.descriptor.action === "ticket.approve" &&
      request.descriptor.target === "ticket:42" &&
      request.descriptor.destination === "jira:acme" &&
      request.fields.every((field) => field === "comment"),
    ...overrides,
  });
}

describe("signed A2UI actions", () => {
  it("reauthenticates and reauthorizes action, target, destination, audience, and fields", async () => {
    const reauthenticate = vi.fn(async () => true);
    const result = await authorize({ reauthenticate });
    expect(result).toEqual({ descriptor, input: { comment: "ship it" } });
    expect(reauthenticate).toHaveBeenCalledWith("user:alice", false);
  });

  it.each([
    ["wrong_audience", { principal: "user:bob" }],
    ["guardrail_changed", { currentGuardrailRevision: "guardrail-8" }],
    ["expired", { now: new Date("2026-07-26T00:06:00.000Z") }],
    ["invalid_input", { input: { comment: "ok", hidden: "smuggled" } }],
    ["reauthentication_required", { reauthenticate: async () => false }],
    ["unauthorized", { authorize: async () => false }],
  ] as const)("denies %s without returning protected input", async (code, overrides) => {
    await expect(authorize(overrides)).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("consumes a nonce exactly once", async () => {
    const nonceStore = new OneUseNonceStore();
    await authorize({ nonceStore });
    await expect(authorize({ nonceStore })).rejects.toEqual(
      expect.objectContaining({ code: "replayed" })
    );
  });

  it("rejects a tampered descriptor", async () => {
    const token = signA2UIAction(descriptor, "test-signing-key");
    const [payload, signature] = token.split(".");
    const tampered = `${payload?.replace("A", "B")}.${signature}`;
    await expect(authorize({ token: tampered })).rejects.toBeInstanceOf(A2UIActionError);
  });

  it("denies a signed disabled action even if the DOM invokes it", async () => {
    const disabled = { ...descriptor, disabled: true } satisfies A2UIActionDescriptor;
    await expect(
      authorize({ token: signA2UIAction(disabled, "test-signing-key") })
    ).rejects.toEqual(expect.objectContaining({ code: "action_disabled" }));
  });
});
