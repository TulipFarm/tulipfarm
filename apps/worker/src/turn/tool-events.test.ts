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
