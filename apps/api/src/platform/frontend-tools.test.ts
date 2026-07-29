import { describe, expect, it } from "vitest";
import type { RequestContext } from "../tools/types";
import {
  clientActionEvent,
  getClientContextTool,
  invokeActionTool,
  navigateToTool,
  prefillFormTool,
} from "./frontend-tools";

const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  userId: "u1",
  presentationContext: {
    target: { channel: "web", surface: "chat" },
    destination: "conversation:1",
    rendererCapabilities: [],
  },
  ...overrides,
});

describe("getClientContextTool", () => {
  it("returns the client context snapshot when present", async () => {
    const res = await getClientContextTool.execute(
      {},
      ctx({ clientContext: { route: "/resources/tickets/T-1", title: "T-1 · Tickets" } })
    );
    expect(res).toEqual({
      success: true,
      data: { available: true, route: "/resources/tickets/T-1", title: "T-1 · Tickets" },
    });
  });

  it("reports unavailable when no client context was sent", async () => {
    const res = await getClientContextTool.execute({}, ctx());
    expect(res).toEqual({ success: true, data: { available: false, route: null, title: null } });
  });
});

describe("navigateToTool", () => {
  it("returns a navigate action descriptor for an internal path", async () => {
    const res = await navigateToTool.execute(
      { to: "/resources/tickets", reason: "you asked" },
      ctx()
    );
    expect(res).toEqual({
      success: true,
      data: { action: "navigate", to: "/resources/tickets", reason: "you asked" },
    });
  });

  it("rejects a non-internal or external path", async () => {
    expect(await navigateToTool.execute({ to: "https://evil.com" }, ctx())).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(await navigateToTool.execute({ to: "//evil.com" }, ctx())).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(await navigateToTool.execute({ to: "" }, ctx())).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });
});

describe("prefillFormTool", () => {
  it("returns a prefill action descriptor with the proposed values", async () => {
    const res = await prefillFormTool.execute({ values: { city: "Pune" } }, ctx());
    expect(res).toEqual({
      success: true,
      data: { action: "prefill", values: { city: "Pune" }, reason: null },
    });
  });
});

describe("invokeActionTool", () => {
  it("returns an invoke action descriptor (payload defaults to {})", async () => {
    const res = await invokeActionTool.execute({ name: "refresh" }, ctx());
    expect(res).toEqual({
      success: true,
      data: { action: "invoke", name: "refresh", payload: {}, reason: null },
    });
  });
});

describe("gating side-effecting actions behind get_client_context", () => {
  it("denies navigate/prefill/invoke until the context has been read this turn", async () => {
    const contextRead = { value: false };
    for (const [tool, args] of [
      [navigateToTool, { to: "/x" }],
      [prefillFormTool, { values: { a: 1 } }],
      [invokeActionTool, { name: "go" }],
    ] as const) {
      expect(await tool.execute(args, ctx({ contextRead }))).toMatchObject({
        success: false,
        error: { code: "validation_error" },
      });
    }
  });

  it("get_client_context flips the per-turn flag so actions are then allowed", async () => {
    const contextRead = { value: false };
    await getClientContextTool.execute({}, ctx({ contextRead }));
    expect(contextRead.value).toBe(true);
    expect(await navigateToTool.execute({ to: "/x" }, ctx({ contextRead }))).toMatchObject({
      success: true,
    });
  });
});

describe("clientActionEvent", () => {
  it("returns the descriptor for every frontend-action tool, null otherwise", () => {
    const result = { success: true as const, data: { action: "navigate", to: "/x" } };
    expect(clientActionEvent("navigate_to", result)).toEqual({ action: "navigate", to: "/x" });
    expect(clientActionEvent("prefill_form", result)).toEqual({ action: "navigate", to: "/x" });
    expect(clientActionEvent("invoke_action", result)).toEqual({ action: "navigate", to: "/x" });
    expect(clientActionEvent("get_client_context", result)).toBeNull();
    expect(
      clientActionEvent("navigate_to", {
        success: false,
        error: { code: "not_found", message: "x" },
      })
    ).toBeNull();
  });
});
