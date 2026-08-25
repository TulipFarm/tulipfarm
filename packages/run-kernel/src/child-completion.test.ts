import { describe, expect, it } from "vitest";
import {
  CHILD_COMPLETION_SCHEMA_REF,
  type ChildCompletionDeps,
  signalChildCompletion,
} from "./child-completion";
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
  limits: { tokens: 100, sideEffects: 1 },
};

function link(overrides: Partial<ChildLink> = {}): ChildLink {
  return {
    parentRunId: PARENT_ID,
    childRunId: CHILD_ID,
    authority: AUTHORITY,
    callId: null,
    resume: { waitId: WAIT_ID, token: "plaintext-token" },
    detachedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

class FakeAncestry implements ChildLinkAncestry {
  constructor(private readonly value: ChildLink | null) {}

  async parentLink(_businessId: string, _childRunId: string): Promise<ChildLink | null> {
    return this.value;
  }
}

class RecordingWaits {
  readonly signals: SignalWaitInput[] = [];
  private delivered = false;

  async signal(input: SignalWaitInput): Promise<WaitSignalResult> {
    this.signals.push(input);
    // Mirrors the store: a one-use token redeemed twice reports a duplicate, never a second resume.
    const outcome = this.delivered ? "duplicate" : "resumed";
    this.delivered = true;
    return { outcome, wait: null } as unknown as WaitSignalResult;
  }
}

function deps(ancestry: ChildLink | null, waits: RecordingWaits): ChildCompletionDeps {
  return { ancestry: new FakeAncestry(ancestry), waits };
}

describe("signalChildCompletion", () => {
  it("resumes the parked parent using the token persisted on the link", async () => {
    const waits = new RecordingWaits();

    const outcome = await signalChildCompletion(deps(link(), waits), {
      businessId: BUSINESS_ID,
      childRunId: CHILD_ID,
      status: "succeeded",
      completedAt: NOW,
    });

    expect(outcome).toMatchObject({ kind: "signalled", parentRunId: PARENT_ID });
    expect(waits.signals).toHaveLength(1);
    expect(waits.signals[0]).toMatchObject({
      id: WAIT_ID,
      runId: PARENT_ID,
      token: "plaintext-token",
      principal: `run:${CHILD_ID}`,
      schemaRef: CHILD_COMPLETION_SCHEMA_REF,
      correlationKey: CHILD_ID,
      signalDigest: "succeeded",
    });
  });

  it("carries a failure through as the signal digest rather than swallowing it", async () => {
    const waits = new RecordingWaits();

    await signalChildCompletion(deps(link(), waits), {
      businessId: BUSINESS_ID,
      childRunId: CHILD_ID,
      status: "failed",
      completedAt: NOW,
    });

    expect(waits.signals[0]?.signalDigest).toBe("failed");
  });

  it("resumes exactly once when the same completion is replayed", async () => {
    const waits = new RecordingWaits();
    const input = {
      businessId: BUSINESS_ID,
      childRunId: CHILD_ID,
      status: "succeeded",
      completedAt: NOW,
    } as const;

    const first = await signalChildCompletion(deps(link(), waits), input);
    const second = await signalChildCompletion(deps(link(), waits), input);

    expect(first).toMatchObject({ kind: "signalled", result: { outcome: "resumed" } });
    expect(second).toMatchObject({ kind: "signalled", result: { outcome: "duplicate" } });
  });

  it.each([
    ["an unparented run", null],
    ["a fire-and-forget child", link({ resume: null })],
    ["a detached child", link({ detachedAt: NOW })],
  ])("does not signal for %s", async (_label, value) => {
    const waits = new RecordingWaits();

    const outcome = await signalChildCompletion(deps(value, waits), {
      businessId: BUSINESS_ID,
      childRunId: CHILD_ID,
      status: "succeeded",
      completedAt: NOW,
    });

    expect(outcome).toEqual({ kind: "not_awaited" });
    expect(waits.signals).toHaveLength(0);
  });
});
