import { ajv } from "@tulipfarm/schema";
import { ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import {
  SLACK_ADAPTER_REF,
  SLACK_TOOL_CONTRACTS,
  SLACK_TOOL_DECLARATIONS,
  SLACK_TOOL_IDS,
} from "./contracts";

const byId = new Map(SLACK_TOOL_CONTRACTS.map((c) => [c.spec.toolId, c]));

describe("SLACK_TOOL_CONTRACTS", () => {
  it("publishes the governed V1 Slack Tool allowlist", () => {
    expect([...byId.keys()]).toEqual([
      SLACK_TOOL_IDS.listChannels,
      SLACK_TOOL_IDS.getConversation,
      SLACK_TOOL_IDS.listMessages,
      SLACK_TOOL_IDS.sendMessage,
      SLACK_TOOL_IDS.updateMessage,
      SLACK_TOOL_IDS.deleteMessage,
      SLACK_TOOL_IDS.acknowledge,
      SLACK_TOOL_IDS.removeReaction,
      SLACK_TOOL_IDS.uploadFile,
      SLACK_TOOL_IDS.getFileInfo,
      SLACK_TOOL_IDS.manageBookmark,
      SLACK_TOOL_IDS.managePin,
      SLACK_TOOL_IDS.lookupUser,
    ]);
  });

  it("keeps acknowledge provider-idempotent, since a mutating Tool may not opt out", () => {
    const acknowledge = byId.get(SLACK_TOOL_IDS.acknowledge);
    expect(acknowledge?.spec.mutating).toBe(true);
    expect(acknowledge?.spec.idempotency.strategy).toBe("provider");
  });

  it("uses provider idempotency for convergent pin add/remove instead of a fake lookup", () => {
    const pin = byId.get(SLACK_TOOL_IDS.managePin);
    expect(pin?.spec.idempotency.strategy).toBe("provider");
    expect(pin?.spec.compensation?.reconciliation).toBeUndefined();
    expect(pin?.spec.retry?.safeToRetry).toBe(true);
  });

  it("never retries ambiguous bookmark writes without provider idempotency", () => {
    const bookmark = byId.get(SLACK_TOOL_IDS.manageBookmark);
    expect(bookmark?.spec.idempotency.strategy).toBe("reconcile");
    expect(bookmark?.spec.compensation?.reconciliation).toBe("slack.bookmark.manage.lookup");
    expect(bookmark?.spec.retry).toEqual({ maxAttempts: 1, safeToRetry: false });
  });

  it("loads into the Tool catalog as a published contract", () => {
    const catalog = ToolCatalog.load(SLACK_TOOL_CONTRACTS);
    for (const contract of SLACK_TOOL_CONTRACTS) {
      expect(catalog.get(contract.spec.toolId, contract.spec.toolVersion)).toBeDefined();
    }
  });

  it("selects each declaration by its independently published Tool version", () => {
    expect(
      SLACK_TOOL_DECLARATIONS.map(({ toolId, toolVersion }) => ({ toolId, toolVersion }))
    ).toEqual(
      SLACK_TOOL_CONTRACTS.map(({ spec }) => ({
        toolId: spec.toolId,
        toolVersion: spec.toolVersion,
      }))
    );
  });

  it("binds to the governed integration adapter, never a raw HTTP passthrough", () => {
    for (const contract of SLACK_TOOL_CONTRACTS) {
      expect(contract.spec.adapter).toEqual({ kind: "integration", ref: SLACK_ADAPTER_REF });
    }
  });

  it("is mutating, medium risk, and never safe to blind-retry after dispatch", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    expect(send.spec.mutating).toBe(true);
    expect(send.spec.riskClass).toBe("medium");
    expect(send.spec.idempotency.strategy).not.toBe("none");
    expect(send.spec.retry?.safeToRetry).toBe(false);
  });

  it("makes channel discovery read-only, low risk, and safe to retry", () => {
    const list = byId.get(SLACK_TOOL_IDS.listChannels);
    if (list === undefined) expect.unreachable("list contract missing");
    expect(list.spec.mutating).toBe(false);
    expect(list.spec.riskClass).toBe("low");
    expect(list.spec.dataClasses).toEqual(["directory"]);
    expect(list.spec.idempotency.strategy).toBe("none");
    expect(list.spec.retry?.safeToRetry).toBe(true);
  });

  it("publishes the bounded, non-empty channel directory output", () => {
    const list = byId.get(SLACK_TOOL_IDS.listChannels);
    if (list === undefined) expect.unreachable("list contract missing");
    const validate = ajv.compile(list.spec.outputSchema);

    expect(validate({ channels: [{ id: "C1234567890", name: "general" }] })).toBe(true);
    expect(validate({ channels: [{ id: "", name: "general" }] })).toBe(false);
    expect(validate({ channels: [{ id: "C1234567890", name: "" }] })).toBe(false);
    expect(
      validate({
        channels: Array.from({ length: 4_001 }, (_, index) => ({
          id: `C${index}`,
          name: `channel-${index}`,
        })),
      })
    ).toBe(false);
  });

  it("keeps message history read-only, bounded, and explicit about not indexing", () => {
    const history = byId.get(SLACK_TOOL_IDS.listMessages);
    if (history === undefined) expect.unreachable("history contract missing");
    expect(history.spec.mutating).toBe(false);
    expect(history.spec.dataClasses).toEqual(["source_content"]);
    expect(history.spec.retry?.safeToRetry).toBe(true);

    const declaration = SLACK_TOOL_DECLARATIONS.find(
      ({ toolId }) => toolId === SLACK_TOOL_IDS.listMessages
    );
    expect(declaration?.description).toMatch(/never writes to Knowledge/i);

    const validateInput = ajv.compile(history.spec.inputSchema);
    expect(validateInput({ channel: "general", limit: 200 })).toBe(true);
    expect(validateInput({ channel: "general", limit: 201 })).toBe(false);
    expect(validateInput({ channel: "general", threadTs: "not-a-timestamp" })).toBe(false);
  });

  it("declares a chat.delete compensation with a reconciliation lookup", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    expect(send.spec.compensation?.operation).toBe("slack.message.delete");
    expect(send.spec.compensation?.reconciliation).toBeTruthy();
  });

  it("requires channel and text, and bounds text length", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    const validate = ajv.compile(send.spec.inputSchema);
    expect(validate({ channel: "general", text: "hi" })).toBe(true);
    expect(validate({ channel: "general" })).toBe(false);
    expect(validate({ text: "hi" })).toBe(false);
    expect(validate({ channel: "general", text: "x".repeat(4001) })).toBe(false);
  });

  it("requires ownership evidence for destructive Integration-owned operations", () => {
    for (const toolId of [
      SLACK_TOOL_IDS.updateMessage,
      SLACK_TOOL_IDS.deleteMessage,
      SLACK_TOOL_IDS.removeReaction,
    ]) {
      const contract = byId.get(toolId);
      if (contract === undefined) expect.unreachable(`${toolId} missing`);
      const validate = ajv.compile(contract.spec.inputSchema);
      expect(validate({})).toBe(false);
    }
  });

  it("bounds conversation reads and user lookup output", () => {
    const conversation = byId.get(SLACK_TOOL_IDS.getConversation);
    const users = byId.get(SLACK_TOOL_IDS.lookupUser);
    if (conversation === undefined || users === undefined) expect.unreachable("read Tool missing");
    expect(ajv.compile(conversation.spec.inputSchema)({ channel: "C1", limit: 201 })).toBe(false);
    const validateUsers = ajv.compile(users.spec.outputSchema);
    expect(
      validateUsers({
        users: [
          { id: "U1", displayName: "Muskan", isBotOrApp: false, deleted: false, email: "no" },
        ],
      })
    ).toBe(false);
  });
});
