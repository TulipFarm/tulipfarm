import type { PersistedRun } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type {
  RemoteAttachResult,
  RemoteDelivery,
  RemoteEventResult,
} from "../internal/delivery-host";
import type { RunOutcome } from "../run-dispatcher";
import { createIntegrationExecutor, type IntegrationExecutorOptions } from "./integration-executor";
import type { RunEventAppendPort } from "./run-events";

const RUN: PersistedRun = {
  id: "run-1",
  businessId: "business-1",
  bundle: { digest: "sha256:bundle", routineId: "integration", routineVersion: "1" },
  identity: {
    initiator: { kind: "integration", id: "chatapp" },
    effectiveSubject: { kind: "integration", id: "chatapp" },
    guardrailContextRef: "sha256:guardrail",
  },
  bounds: { wallTimeMs: 60_000, activeTimeMs: 30_000, attempts: 3, sideEffects: 10 },
  status: "running",
  version: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: null,
  resultArtifactId: null,
  errorEvidenceRef: null,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-01-01T00:01:00.000Z",
};

const DELIVERY: RemoteDelivery = {
  slug: "chatapp",
  body: { team: "T1", event: { channel: "C1", ts: "100.1" } },
  headers: { "x-sig": "v0=abc" },
  classifier: { source: "({ classify() {} })", hash: "hash-1" },
  hasThreadMapping: false,
  chatEnabled: true,
  eventsEnabled: true,
};

const CHAT_DECISION = {
  kind: "chat",
  sender: "EXT-U1",
  text: "summarize this",
  reply: { binding: "default", vars: { channel: "C1" } },
};

interface Recorded {
  readonly events: { eventType: string; payload: Record<string, unknown>; key: string }[];
  readonly classified: { source: string; hash: string | undefined; invocation: unknown }[];
  readonly attached: unknown[];
  readonly recordedEvents: unknown[];
  readonly replies: unknown[];
  readonly turns: number;
}

function harness(
  over: {
    delivery?: RemoteDelivery | undefined;
    decision?: unknown;
    classifyThrows?: Error;
    attach?: RemoteAttachResult;
    event?: RemoteEventResult;
    outcome?: RunOutcome;
  } = {}
): { execute: () => Promise<RunOutcome>; recorded: Recorded } {
  const events: Recorded["events"] = [];
  const classified: Recorded["classified"] = [];
  const attached: unknown[] = [];
  const recordedEvents: unknown[] = [];
  const replies: unknown[] = [];
  let turns = 0;
  let sequence = 0;

  const deliveries: IntegrationExecutorOptions["deliveries"] = {
    describe: async () => ("delivery" in over ? over.delivery : DELIVERY),
    attachChat: async (_runId, decision) => {
      attached.push(decision);
      return over.attach ?? { outcome: "attached", turnId: "turn-1", attempt: 1 };
    },
    recordEvent: async (_runId, event) => {
      recordedEvents.push(event);
      return over.event ?? { outcome: "recorded", eventId: "event-1" };
    },
    postReply: async (_runId, reply) => {
      replies.push(reply);
      return { delivered: true };
    },
  };

  const executor = createIntegrationExecutor({
    deliveries,
    hooks: {
      runRoutineHook: async (source, _fn, invocation, _args, _breaker, options) => {
        classified.push({ source, hash: options?.expectedHash, invocation });
        if (over.classifyThrows) throw over.classifyThrows;
        return "decision" in over ? over.decision : CHAT_DECISION;
      },
    },
    events: {
      append: async (input) => {
        sequence += 1;
        events.push({
          eventType: input.eventType,
          payload: input.payload,
          key: input.idempotencyKey,
        });
        return { sequence };
      },
    } satisfies RunEventAppendPort,
    turn: async () => {
      turns += 1;
      return over.outcome ?? "succeeded";
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  return {
    execute: () => executor(RUN),
    recorded: {
      events,
      classified,
      attached,
      recordedEvents,
      replies,
      get turns() {
        return turns;
      },
    },
  };
}

describe("createIntegrationExecutor", () => {
  it("classifies the stored envelope against the hash the manifest recorded", async () => {
    const { execute, recorded } = harness();

    await execute();

    expect(recorded.classified).toEqual([
      {
        source: DELIVERY.classifier.source,
        hash: DELIVERY.classifier.hash,
        invocation: {
          body: DELIVERY.body,
          headers: DELIVERY.headers,
          hasThreadMapping: false,
        },
      },
    ]);
  });

  it("answers a chat decision on this same Run and replies to the channel", async () => {
    const { execute, recorded } = harness();

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.attached).toEqual([
      {
        sender: CHAT_DECISION.sender,
        text: CHAT_DECISION.text,
        requireExistingThread: false,
        reply: CHAT_DECISION.reply,
      },
    ]);
    expect(recorded.turns).toBe(1);
    expect(recorded.replies).toEqual([
      { attempt: 1, outcome: "answered", binding: "default", vars: { channel: "C1" } },
    ]);
  });

  it("records exactly one classification per delivery, whatever it decided", async () => {
    // "Why did Slack not reply?" has to be answerable from a recorded row, never from the absence
    // of one — and a redelivery must not double the record.
    for (const decision of [
      CHAT_DECISION,
      { kind: "ignore", reason: "bot message" },
      { kind: "event", eventType: "member_joined" },
      { not: "a decision" },
    ]) {
      const { execute, recorded } = harness({ decision });

      await execute();

      const classifications = recorded.events.filter(
        (event) => event.eventType === "delivery.classified"
      );
      expect(classifications).toHaveLength(1);
      expect(classifications[0]?.key).toBe(`${RUN.id}:0:classified`);
    }
  });

  it("closes an ignored delivery with the classifier's reason and runs no turn", async () => {
    const { execute, recorded } = harness({ decision: { kind: "ignore", reason: "bot message" } });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.turns).toBe(0);
    expect(recorded.replies).toEqual([]);
    expect(recorded.events[0]?.payload).toEqual({ decision: "ignore", reason: "bot message" });
  });

  it("records an event decision without running a turn", async () => {
    const { execute, recorded } = harness({
      decision: { kind: "event", eventType: "member_joined", payload: { user: "U2" } },
    });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.recordedEvents).toEqual([
      { eventType: "member_joined", payload: { user: "U2" } },
    ]);
    expect(recorded.turns).toBe(0);
    expect(recorded.events[0]?.payload).toEqual({
      decision: "event",
      eventType: "member_joined",
    });
  });

  it("records why an event the host refused was dropped", async () => {
    const { execute, recorded } = harness({
      decision: { kind: "event", eventType: "message_deleted" },
      event: { outcome: "ignored", reason: "event_type_not_allowlisted" },
    });

    await execute();

    expect(recorded.events[0]?.payload).toEqual({
      decision: "ignore",
      reason: "event_type_not_allowlisted",
    });
  });

  it("records classifier output it cannot parse rather than retrying it forever", async () => {
    // Malformed output is deterministic: a retry reproduces it, so the Run is closed on the record.
    const { execute, recorded } = harness({ decision: { kind: "chat", sender: 42 } });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.events[0]?.payload).toEqual({ decision: "invalid" });
    expect(recorded.turns).toBe(0);
  });

  it("lets a classifier that throws take the lease with it, so the delivery is retried", async () => {
    const { execute, recorded } = harness({ classifyThrows: new Error("isolate timed out") });

    await expect(execute()).rejects.toThrow("isolate timed out");

    expect(recorded.events).toEqual([]);
  });

  it("runs no turn for an unlinked sender and never learns the bind link", async () => {
    const { execute, recorded } = harness({ attach: { outcome: "unlinked" } });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.turns).toBe(0);
    expect(recorded.replies).toEqual([]);
    expect(recorded.events[0]?.payload).toEqual({
      decision: "ignore",
      reason: "sender_unlinked",
    });
  });

  it("records the host's reason when it refuses to attach the chat", async () => {
    const { execute, recorded } = harness({
      attach: { outcome: "ignored", reason: "sender_not_thread_owner" },
    });

    await execute();

    expect(recorded.turns).toBe(0);
    expect(recorded.events[0]?.payload).toEqual({
      decision: "ignore",
      reason: "sender_not_thread_owner",
    });
  });

  it("ignores a chat decision the manifest never declared chat for", async () => {
    const { execute, recorded } = harness({
      delivery: { ...DELIVERY, chatEnabled: false },
    });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.attached).toEqual([]);
    expect(recorded.events[0]?.payload).toEqual({
      decision: "ignore",
      reason: "chat_not_declared",
    });
  });

  it("posts nothing while the turn is still open, and the failure reply when it broke", async () => {
    // A parked approval has not answered anything yet; replying would answer an open question.
    const waiting = harness({ outcome: "waiting" });
    await expect(waiting.execute()).resolves.toBe("waiting");
    expect(waiting.recorded.replies).toEqual([]);

    const cancelled = harness({ outcome: "cancelled" });
    await expect(cancelled.execute()).resolves.toBe("cancelled");
    expect(cancelled.recorded.replies).toEqual([]);

    const failed = harness({ outcome: "failed" });
    await expect(failed.execute()).resolves.toBe("failed");
    expect(failed.recorded.replies).toEqual([
      { attempt: 1, outcome: "failed", binding: "default", vars: { channel: "C1" } },
    ]);
  });

  it("succeeds without a record when the Run is no longer a live delivery", async () => {
    const { execute, recorded } = harness({ delivery: undefined });

    await expect(execute()).resolves.toBe("succeeded");

    expect(recorded.classified).toEqual([]);
    expect(recorded.events).toEqual([]);
  });
});
