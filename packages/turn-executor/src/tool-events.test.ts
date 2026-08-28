import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import { canonicalHash } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";
import { announceToolCalls } from "./tool-events";

/** The Run coordinates every dispatch carries; the announcer cares only about the call. */
const CALL = { businessId: "biz", runId: "run-1", stateId: "state-1" } as const;

class FakeAppendPort implements RunEventAppendPort {
  readonly appended: { eventType: string; payload: Record<string, unknown>; key: string }[] = [];
  private sequence = 0;

  async append(input: {
    eventType: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ sequence: number }> {
    this.sequence += 1;
    this.appended.push({
      eventType: input.eventType,
      payload: input.payload,
      key: input.idempotencyKey,
    });
    return { sequence: this.sequence };
  }
}

function writer(events: RunEventAppendPort): TurnEventWriter {
  return new TurnEventWriter({
    events,
    businessId: "biz",
    runId: "run-1",
    turnId: "turn-1",
    attempt: 1,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

function port(result: (request: ToolDispatchRequest) => ToolDispatchResult): {
  port: ToolDispatchPort;
  calls: ToolDispatchRequest[];
} {
  const calls: ToolDispatchRequest[] = [];
  return {
    calls,
    port: {
      dispatch: async (request): Promise<ToolDispatchResult> => {
        calls.push(request);
        return result(request);
      },
    },
  };
}

const REQUEST: ToolDispatchRequest = {
  ...CALL,
  callId: "call-1",
  name: "send_email",
  arguments: { to: "someone@example.com", body: "the quarterly numbers" },
};

/** Advances 25ms per read, so the announced duration is asserted rather than raced. */
function clock(): () => number {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  let reads = 0;
  return () => {
    const value = start + reads * 25;
    reads += 1;
    return value;
  };
}

describe("announceToolCalls", () => {
  it("announces a call and its result without reproducing the arguments verbatim", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: { id: "msg-1" },
    }));

    const result = await announceToolCalls(broker.port, writer(events), {
      now: clock(),
    }).dispatch(REQUEST);

    expect(result).toEqual({ status: "succeeded", callId: "call-1", output: { id: "msg-1" } });
    expect(broker.calls).toEqual([REQUEST]);
    expect(events.appended).toEqual([
      {
        eventType: "tool.call",
        payload: {
          callId: "call-1",
          name: "send_email",
          // The digest is still the authority on what was called: it hashes the verbatim
          // arguments, so a redacted or truncated preview cannot quietly change the record.
          argsDigest: canonicalHash(REQUEST.arguments ?? null),
          argsPreview: {
            json: JSON.stringify(REQUEST.arguments),
            bytes: JSON.stringify(REQUEST.arguments).length,
          },
          stepId: "state-1",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
        key: "turn-1:1:tool:call:call-1",
      },
      {
        eventType: "tool.result",
        payload: {
          callId: "call-1",
          status: "ok",
          resultPreview: { json: '{"id":"msg-1"}', bytes: 14 },
          durationMs: 25,
        },
        key: "turn-1:1:tool:result:call-1",
      },
    ]);
  });

  it("redacts credential material out of the preview while the digest still covers it", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: { ok: true },
    }));
    const request: ToolDispatchRequest = {
      ...REQUEST,
      arguments: { channel: "#ops", apiKey: "sk-abcdefghijklmnopqrstuvwx" },
    };

    await announceToolCalls(broker.port, writer(events), { now: clock() }).dispatch(request);

    const call = events.appended[0]?.payload as {
      argsDigest: string;
      argsPreview: { json: string; redactedPaths?: string[] };
    };
    expect(JSON.parse(call.argsPreview.json)).toEqual({
      channel: "#ops",
      apiKey: "[redacted]",
    });
    expect(call.argsPreview.redactedPaths).toEqual(["apiKey"]);
    // The digest is taken before redaction, so the audit record is unchanged by what was shown.
    expect(call.argsDigest).toBe(canonicalHash(request.arguments ?? null));
  });

  it("announces surface.emitted after a present call that rendered a Surface Artifact", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: {
        artifact: { id: "artifact-1", component: { name: "RecordTable", version: "1.0" } },
        actionHandles: {},
      },
    }));
    const request: ToolDispatchRequest = { ...REQUEST, name: "present" };

    await announceToolCalls(broker.port, writer(events), { now: clock() }).dispatch(request);

    expect(events.appended.map((event) => event.eventType)).toEqual([
      "tool.call",
      "tool.result",
      "surface.emitted",
    ]);
    expect(events.appended.at(-1)).toEqual({
      eventType: "surface.emitted",
      payload: { artifactId: "artifact-1", componentId: "RecordTable" },
      key: "turn-1:1:surface:emitted:call-1",
    });
  });

  /** The declaring call: `plan_declare` is a pure echo, so the plan lives in its arguments. */
  function declares(rounds: unknown, callId = "call-1"): ToolDispatchRequest {
    return { ...REQUEST, callId, name: "plan_declare", arguments: { rounds } };
  }

  const ECHO = port((request) => ({
    status: "succeeded" as const,
    callId: request.callId,
    output: request.arguments,
  }));

  it("announces plan.declared before the result, so the Round it forecasts renders in flight", async () => {
    // Published on the result it still beat the reads dispatched beside it, but by a margin too
    // small to see: every step in Round 1 went from unstarted to done without ever spinning.
    const events = new FakeAppendPort();

    await announceToolCalls(ECHO.port, writer(events), { now: clock() }).dispatch(
      declares([
        { calls: [{ tool: "resource_type_schema", label: "Read the Ticket schema" }] },
        { calls: [{ tool: "routine_forge" }] },
      ])
    );

    expect(events.appended.map((event) => event.eventType)).toEqual([
      "tool.call",
      "plan.declared",
      "tool.result",
    ]);
    expect(events.appended[1]).toEqual({
      eventType: "plan.declared",
      payload: {
        revision: 1,
        rounds: [
          { calls: [{ tool: "resource_type_schema", label: "Read the Ticket schema" }] },
          { calls: [{ tool: "routine_forge" }] },
        ],
      },
      key: "turn-1:1:plan:declared:call-1",
    });
  });

  it("declines to announce a plan of one round, which is a list rather than a plan", async () => {
    const events = new FakeAppendPort();

    await announceToolCalls(ECHO.port, writer(events), { now: clock() }).dispatch(
      declares([{ calls: [{ tool: "get_memory" }] }])
    );

    expect(events.appended.map((event) => event.eventType)).toEqual(["tool.call", "tool.result"]);
  });

  it("refuses a plan from any Tool but the one that declares plans", async () => {
    // Integration arguments can be attacker-influenced. Matching a plan structurally would let a
    // third party whose payload carried a `rounds` key rewrite what the Agent said it would do.
    const events = new FakeAppendPort();

    await announceToolCalls(ECHO.port, writer(events), { now: clock() }).dispatch({
      ...REQUEST,
      name: "github_issue_get",
      arguments: { rounds: [{ calls: [{ tool: "a" }] }, { calls: [{ tool: "b" }] }] },
    });

    expect(events.appended.map((event) => event.eventType)).toEqual(["tool.call", "tool.result"]);
  });

  it("drops a plan too large for the event schema rather than failing the Turn on it", async () => {
    // `emit` validates and throws, so a plan accepted by the extractor and refused by the schema
    // would fail the Turn outright.
    const events = new FakeAppendPort();

    await expect(
      announceToolCalls(ECHO.port, writer(events), { now: clock() }).dispatch(
        declares(Array.from({ length: 9 }, () => ({ calls: [{ tool: "a" }] })))
      )
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(events.appended.map((event) => event.eventType)).toEqual(["tool.call", "tool.result"]);
  });

  it("numbers each plan the Turn declares, so a revision can be told from its predecessor", async () => {
    const events = new FakeAppendPort();
    const rounds = [{ calls: [{ tool: "a" }] }, { calls: [{ tool: "b" }] }];
    const announcer = announceToolCalls(ECHO.port, writer(events), { now: clock() });

    await announcer.dispatch(declares(rounds));
    await announcer.dispatch(declares(rounds, "call-2"));

    expect(
      events.appended
        .filter((event) => event.eventType === "plan.declared")
        .map((event) => event.payload.revision)
    ).toEqual([1, 2]);
  });

  it("reports a refused call as an error carrying the dispatcher's own reason", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "denied",
      callId: request.callId,
      reason: "tool_blocklist: tool_blocklist:send_email",
    }));

    await announceToolCalls(broker.port, writer(events), { now: clock() }).dispatch(REQUEST);

    expect(events.appended.at(-1)).toEqual({
      eventType: "tool.result",
      payload: {
        callId: "call-1",
        status: "error",
        summary: "tool_blocklist: tool_blocklist:send_email",
        errorCode: "denied",
        durationMs: 25,
      },
      key: "turn-1:1:tool:result:call-1",
    });
  });

  it("stays silent about the result of a call that is waiting on an approval", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "awaiting_approval",
      callId: request.callId,
      approvalId: "appr-1",
    }));

    const result = await announceToolCalls(broker.port, writer(events), {
      now: clock(),
    }).dispatch(REQUEST);

    expect(result).toMatchObject({ status: "awaiting_approval", approvalId: "appr-1" });
    // The call is announced, the outcome is not: the driver announces the wait, and a `tool.result`
    // here would tell a reader the call finished while it is still pending.
    expect(events.appended.map((event) => event.eventType)).toEqual(["tool.call"]);
  });
});

describe("carrying what ran at the same time", () => {
  it("announces the batch a call belonged to, and keeps it on the durable record", async () => {
    const events = new FakeAppendPort();
    const eventWriter = writer(events);
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: {},
    }));
    const dispatch = announceToolCalls(broker.port, eventWriter, { now: clock() }).dispatch;

    await dispatch({ ...REQUEST, callId: "call-1", batchId: "state-1:0:0" });
    await dispatch({ ...REQUEST, callId: "call-2", batchId: "state-1:0:0" });

    const announced = events.appended.filter((event) => event.eventType === "tool.call");
    expect(announced.map((event) => event.payload.batchId)).toEqual(["state-1:0:0", "state-1:0:0"]);
    // The Message metadata is what a Turn re-read months later hydrates from, so the fact has to
    // survive the hop out of the event stream and into the durable record.
    expect(eventWriter.toolCalls.map((call) => call.batchId)).toEqual([
      "state-1:0:0",
      "state-1:0:0",
    ]);
  });

  it("leaves a solo call unmarked all the way through", async () => {
    const events = new FakeAppendPort();
    const eventWriter = writer(events);
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: {},
    }));

    await announceToolCalls(broker.port, eventWriter, { now: clock() }).dispatch(REQUEST);

    const announced = events.appended.find((event) => event.eventType === "tool.call");
    expect(announced?.payload).not.toHaveProperty("batchId");
    expect(eventWriter.toolCalls[0]).not.toHaveProperty("batchId");
  });
});
