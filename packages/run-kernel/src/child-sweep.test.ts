import { describe, expect, it } from "vitest";
import type { ChildCompletionDeps } from "./child-completion";
import {
  ChildCompletionSweeper,
  type UnsignalledChildCompletion,
  type UnsignalledChildStore,
} from "./child-sweep";
import type { ChildAuthority, ChildLink, ChildLinkAncestry } from "./children";
import type { SignalWaitInput, WaitSignalResult } from "./waits";

const BUSINESS_ID = "business-1";
const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";
const WAIT_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = "2024-01-01T00:00:00.000Z";

const AUTHORITY: ChildAuthority = {
  tools: ["crm.read"],
  classifications: ["internal"],
  limits: { tokens: 100 },
};

function link(overrides: Partial<ChildLink> = {}): ChildLink {
  return {
    parentRunId: PARENT_ID,
    childRunId: CHILD_ID,
    authority: AUTHORITY,
    authorityBinding: "delegated",
    callId: null,
    resume: { waitId: WAIT_ID, token: "plaintext-token" },
    detachedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

class FakeAncestry implements ChildLinkAncestry {
  constructor(private readonly value: ChildLink | null) {}

  async parentLink(): Promise<ChildLink | null> {
    return this.value;
  }
}

class RecordingWaits {
  readonly signals: SignalWaitInput[] = [];
  private delivered = false;

  async signal(input: SignalWaitInput): Promise<WaitSignalResult> {
    this.signals.push(input);
    const outcome = this.delivered ? "duplicate" : "resumed";
    this.delivered = true;
    return { outcome, wait: null } as unknown as WaitSignalResult;
  }
}

class FakeStore implements UnsignalledChildStore {
  readonly asked: { businessId: string; limit: number }[] = [];

  constructor(private readonly rows: readonly UnsignalledChildCompletion[]) {}

  async listUnsignalledCompletions(
    businessId: string,
    limit: number
  ): Promise<readonly UnsignalledChildCompletion[]> {
    this.asked.push({ businessId, limit });
    return this.rows;
  }
}

function harness(rows: readonly UnsignalledChildCompletion[], ancestry: ChildLink | null = link()) {
  const waits = new RecordingWaits();
  const store = new FakeStore(rows);
  const deps: ChildCompletionDeps = { ancestry: new FakeAncestry(ancestry), waits };
  return { waits, store, sweeper: new ChildCompletionSweeper(store, deps) };
}

function completion(
  overrides: Partial<UnsignalledChildCompletion> = {}
): UnsignalledChildCompletion {
  return { childRunId: CHILD_ID, status: "succeeded", finishedAt: NOW, ...overrides };
}

describe("ChildCompletionSweeper", () => {
  it("wakes a parent whose child was cancelled, which no other path signals", async () => {
    // Cancellation cascades from parent to child and never back up, so before this sweep a child
    // cancelled on its own left its parent parked until the wait's deadline expired.
    const { sweeper, waits } = harness([completion({ status: "cancelled" })]);

    const outcomes = await sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 });

    expect(waits.signals).toHaveLength(1);
    expect(waits.signals[0]?.signalDigest).toBe("cancelled");
    expect(waits.signals[0]?.runId).toBe(PARENT_ID);
    expect(outcomes[0]).toMatchObject({ kind: "signalled", parentRunId: PARENT_ID });
  });

  it("redelivers a completion whose signal was lost after the child committed", async () => {
    // The terminal commit and the signal are separate steps, so a crash between them drops the
    // wake-up. The durable state still says terminal-and-awaited, which is what this reads.
    const { sweeper, waits } = harness([completion({ status: "failed" })]);

    await sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 });

    expect(waits.signals[0]?.signalDigest).toBe("failed");
    expect(waits.signals[0]?.correlationKey).toBe(CHILD_ID);
  });

  it("carries the child's own completion time, not the sweep's", async () => {
    const finishedAt = "2024-01-01T00:00:05.000Z";
    const { sweeper, waits } = harness([completion({ finishedAt })]);

    await sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 });

    expect(waits.signals[0]?.receivedAt).toBe(finishedAt);
  });

  it("does not resume a parent twice when the signal already landed", async () => {
    const { sweeper, waits } = harness([completion(), completion()]);

    const outcomes = await sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 });

    // The one-use token is what makes replay safe, and replay is what makes the sweep simple.
    expect(waits.signals).toHaveLength(2);
    expect(outcomes[1]).toMatchObject({ kind: "signalled", result: { outcome: "duplicate" } });
  });

  it("signals nothing for a child whose parent detached from it", async () => {
    const { sweeper, waits } = harness([completion()], link({ detachedAt: NOW }));

    const outcomes = await sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 });

    expect(waits.signals).toEqual([]);
    expect(outcomes[0]).toEqual({ kind: "not_awaited" });
  });

  it("bounds each sweep by the caller's limit", async () => {
    const { sweeper, store } = harness([]);

    await sweeper.sweep({ businessId: BUSINESS_ID, limit: 25 });

    expect(store.asked).toEqual([{ businessId: BUSINESS_ID, limit: 25 }]);
  });

  it("signals nothing when no child is waiting to be reconciled", async () => {
    const { sweeper, waits } = harness([]);

    await expect(sweeper.sweep({ businessId: BUSINESS_ID, limit: 10 })).resolves.toEqual([]);
    expect(waits.signals).toEqual([]);
  });
});
