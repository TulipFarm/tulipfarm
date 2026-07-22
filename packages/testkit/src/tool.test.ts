import { describe, expect, it } from "vitest";
import { FakeToolAdapter } from "./tool";

type ToolRequest = { action: string; arguments: Record<string, unknown> };
type ToolResponse = { ok: boolean; value?: unknown };

describe("FakeToolAdapter", () => {
  it("executes scripted Tool outcomes and captures requests", async () => {
    const tool = new FakeToolAdapter<ToolRequest, ToolResponse>();
    tool.respondUsing(({ request }) => ({
      ok: true,
      value: { id: "ticket-1", action: request.action },
    }));

    await expect(
      tool.execute({ action: "ticket.create", arguments: { title: "Broken build" } })
    ).resolves.toEqual({ ok: true, value: { id: "ticket-1", action: "ticket.create" } });
    expect(tool.calls).toEqual([{ action: "ticket.create", arguments: { title: "Broken build" } }]);
    expect(() => tool.assertDrained()).not.toThrow();
  });

  it("injects adapter errors without retrying or silently falling back", async () => {
    const tool = new FakeToolAdapter<ToolRequest, ToolResponse>();
    tool.failWith(new Error("ambiguous provider outcome"));

    await expect(tool.execute({ action: "ticket.create", arguments: {} })).rejects.toThrow(
      "ambiguous provider outcome"
    );
    expect(tool.calls).toHaveLength(1);
  });

  it("returns callable response values without invoking them as factories", async () => {
    const callable = () => "run later";
    const tool = new FakeToolAdapter<ToolRequest, typeof callable>();
    tool.respondWith(callable);

    await expect(tool.execute({ action: "callback.get", arguments: {} })).resolves.toBe(callable);
  });
});
