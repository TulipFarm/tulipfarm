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

describe("announceToolCalls", () => {
  it("announces a call and its result without reproducing the arguments", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "succeeded",
      callId: request.callId,
      output: { id: "msg-1" },
    }));

    const result = await announceToolCalls(broker.port, writer(events)).dispatch(REQUEST);

    expect(result).toEqual({ status: "succeeded", callId: "call-1", output: { id: "msg-1" } });
    expect(broker.calls).toEqual([REQUEST]);
    // The recipient and the body are what the call is about, and this stream is read by whoever is
    // in the conversation — so the arguments travel as a digest and nothing else.
    expect(events.appended).toEqual([
      {
        eventType: "tool.call",
        payload: {
          callId: "call-1",
          name: "send_email",
          argsDigest: canonicalHash(REQUEST.arguments ?? null),
        },
        key: "turn-1:1:tool:call:call-1",
      },
      {
        eventType: "tool.result",
        payload: { callId: "call-1", status: "ok" },
        key: "turn-1:1:tool:result:call-1",
      },
    ]);
  });

  it("reports a refused call as an error carrying the dispatcher's own reason", async () => {
    const events = new FakeAppendPort();
    const broker = port((request) => ({
      status: "denied",
      callId: request.callId,
      reason: "tool_blocklist: tool_blocklist:send_email",
    }));

    await announceToolCalls(broker.port, writer(events)).dispatch(REQUEST);

    expect(events.appended.at(-1)).toEqual({
      eventType: "tool.result",
      payload: {
        callId: "call-1",
        status: "error",
        summary: "tool_blocklist: tool_blocklist:send_email",
        errorCode: "denied",
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

    const result = await announceToolCalls(broker.port, writer(events)).dispatch(REQUEST);

    expect(result).toMatchObject({ status: "awaiting_approval", approvalId: "appr-1" });
    // The call is announced, the outcome is not: the driver announces the wait, and a `tool.result`
    // here would tell a reader the call finished while it is still pending.
    expect(events.appended.map((event) => event.eventType)).toEqual(["tool.call"]);
  });
});
