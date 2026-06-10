import { describe, expect, it, vi } from "vitest";
import { APPROVAL_TIMEOUT_MS, ApprovalRegistry } from "./approvals";
import type { StreamEmitter } from "./stream-emitter";

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

function fakeEmitter(): { events: Emitted[]; emitter: StreamEmitter } {
  const events: Emitted[] = [];
  const emitter: StreamEmitter = {
    emit: async (type, data) => {
      events.push({ type, data: data as Record<string, unknown> });
    },
  };
  return { events, emitter };
}

const reqId = (events: Emitted[]): string =>
  events.find((e) => e.type === "approval-request")?.data.approvalId as string;

describe("ApprovalRegistry", () => {
  it("emits approval-request (with id/expiry) and resolves approved on decide", async () => {
    const reg = new ApprovalRegistry();
    const { events, emitter } = fakeEmitter();
    const p = reg.request(emitter, { toolCallId: "c1", toolName: "write_x", args: { a: 1 } });

    const req = events.find((e) => e.type === "approval-request");
    expect(req?.data).toMatchObject({ toolCallId: "c1", toolName: "write_x", args: { a: 1 } });
    expect(typeof req?.data.approvalId).toBe("string");
    expect(typeof req?.data.expiresAt).toBe("string");

    expect(reg.decide(reqId(events), "approved")).toBe(true);
    await expect(p).resolves.toEqual({ outcome: "approved" });
    expect(
      events.some((e) => e.type === "approval-resolved" && e.data.outcome === "approved")
    ).toBe(true);
  });

  it("resolves denied (with reason) on decide('denied')", async () => {
    const reg = new ApprovalRegistry();
    const { events, emitter } = fakeEmitter();
    const p = reg.request(emitter, { toolCallId: "c1", toolName: "write_x", args: {} });

    expect(reg.decide(reqId(events), "denied")).toBe(true);
    await expect(p).resolves.toEqual({ outcome: "denied", reason: expect.any(String) });
    expect(events.some((e) => e.type === "approval-resolved" && e.data.outcome === "denied")).toBe(
      true
    );
  });

  it("decide returns false for an unknown or already-resolved id", async () => {
    const reg = new ApprovalRegistry();
    const { events, emitter } = fakeEmitter();
    expect(reg.decide("nope", "approved")).toBe(false);

    const p = reg.request(emitter, { toolCallId: "c1", toolName: "t", args: {} });
    const id = reqId(events);
    expect(reg.decide(id, "approved")).toBe(true);
    expect(reg.decide(id, "approved")).toBe(false); // already resolved
    await p;
  });

  it("auto-denies (timeout) after APPROVAL_TIMEOUT_MS, then decide is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const reg = new ApprovalRegistry();
      const { events, emitter } = fakeEmitter();
      const p = reg.request(emitter, { toolCallId: "c1", toolName: "t", args: {} });

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);

      await expect(p).resolves.toEqual({ outcome: "timeout", reason: expect.any(String) });
      expect(
        events.some((e) => e.type === "approval-resolved" && e.data.outcome === "timeout")
      ).toBe(true);
      expect(reg.decide(reqId(events), "approved")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
