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

describe("ApprovalRegistry.listPending", () => {
  it("is empty with nothing in flight", () => {
    expect(new ApprovalRegistry().listPending()).toEqual([]);
  });

  it("projects an in-flight request into a listable row", () => {
    const reg = new ApprovalRegistry();
    const { events, emitter } = fakeEmitter();
    void reg.request(emitter, { toolCallId: "c1", toolName: "write_x", args: { a: 1 } });

    const rows = reg.listPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolCallId: "c1", toolName: "write_x", args: { a: 1 } });
    expect(rows[0]?.approvalId).toBe(reqId(events));
    expect(typeof rows[0]?.expiresAt).toBe("string");
    expect(typeof rows[0]?.createdAt).toBe("string");
  });

  it("drops an entry once it is decided", async () => {
    const reg = new ApprovalRegistry();
    const { events, emitter } = fakeEmitter();
    const p = reg.request(emitter, { toolCallId: "c1", toolName: "t", args: {} });
    expect(reg.listPending()).toHaveLength(1);

    reg.decide(reqId(events), "approved");
    expect(reg.listPending()).toEqual([]);
    await p;
  });

  it("drops an entry once it times out", async () => {
    vi.useFakeTimers();
    try {
      const reg = new ApprovalRegistry();
      const { emitter } = fakeEmitter();
      const p = reg.request(emitter, { toolCallId: "c1", toolName: "t", args: {} });
      expect(reg.listPending()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
      expect(reg.listPending()).toEqual([]);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists multiple entries oldest-first", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const reg = new ApprovalRegistry();
      const { events, emitter } = fakeEmitter();
      void reg.request(emitter, { toolCallId: "c1", toolName: "first", args: {} });
      vi.advanceTimersByTime(1000);
      void reg.request(emitter, { toolCallId: "c2", toolName: "second", args: {} });

      const ids = events
        .filter((e) => e.type === "approval-request")
        .map((e) => e.data.approvalId as string);
      const rows = reg.listPending();
      expect(rows.map((r) => r.approvalId)).toEqual(ids);
      expect(rows.map((r) => r.toolName)).toEqual(["first", "second"]);
      expect((rows[0]?.createdAt ?? "") <= (rows[1]?.createdAt ?? "")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
