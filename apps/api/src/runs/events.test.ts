import { describe, expect, it } from "vitest";
import {
  parseAfterCursor,
  type RunEventReader,
  type RunEventRecord,
  type RunStatusReader,
  type RunStreamGrant,
  type SseSink,
  streamRunEvents,
} from "./events";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const GRANT: RunStreamGrant = { businessId: BUSINESS_ID, audiences: ["participant"] };

function record(sequence: number, overrides: Partial<RunEventRecord> = {}): RunEventRecord {
  return {
    sequence,
    eventType: "state.transitioned",
    audience: "participant",
    payload: { stateKey: "apply" },
    occurredAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

class FakeEventReader implements RunEventReader {
  calls: Array<{ after: number; audiences: readonly string[] }> = [];

  constructor(private readonly events: RunEventRecord[]) {}

  async list(
    _businessId: string,
    _runId: string,
    options: { after: number; audiences: readonly string[]; limit?: number }
  ): Promise<readonly RunEventRecord[]> {
    this.calls.push({ after: options.after, audiences: options.audiences });
    return this.events
      .filter(
        (event) => event.sequence > options.after && options.audiences.includes(event.audience)
      )
      .slice(0, options.limit ?? 200);
  }
}

class FakeRunReader implements RunStatusReader {
  constructor(private readonly status: string | null) {}
  async find() {
    return this.status === null ? null : { status: this.status };
  }
}

class RecordingSink implements SseSink {
  chunks: string[] = [];
  destroyed = false;
  ended = false;
  drains = 0;
  /** Sequence numbers at which `write` reports a full buffer. */
  backpressureAt = new Set<number>();
  private writes = 0;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this.writes += 1;
    return !this.backpressureAt.has(this.writes);
  }

  async waitForDrain(): Promise<void> {
    this.drains += 1;
  }

  end(): void {
    this.ended = true;
  }
}

const noSleep = async () => {};

function ids(sink: RecordingSink): number[] {
  return sink.chunks.map((chunk) => Number(/^id: (\d+)/.exec(chunk)?.[1]));
}

function types(sink: RecordingSink): string[] {
  return sink.chunks.map((chunk) => /event: (.+)/.exec(chunk)?.[1] ?? "");
}

describe("parseAfterCursor", () => {
  it("prefers an explicit query cursor", () => {
    expect(parseAfterCursor("7", 3)).toBe(3);
  });

  it("falls back to the SSE reconnect header", () => {
    expect(parseAfterCursor("7", undefined)).toBe(7);
  });

  it("treats a missing or malformed cursor as the start of the stream", () => {
    expect(parseAfterCursor(undefined, undefined)).toBe(0);
    expect(parseAfterCursor("not-a-number", undefined)).toBe(0);
    expect(parseAfterCursor("-4", undefined)).toBe(0);
  });
});

describe("streamRunEvents", () => {
  const deps = (
    events: RunEventRecord[],
    status: string | null,
    grant: () => Promise<RunStreamGrant | null> = async () => GRANT
  ) => ({
    events: new FakeEventReader(events),
    runs: new FakeRunReader(status),
    authorize: grant,
    sleep: noSleep,
  });

  it("delivers the backlog in sequence order and closes on a terminal Run", async () => {
    const sink = new RecordingSink();

    const outcome = await streamRunEvents(sink, deps([record(1), record(2)], "succeeded"), {
      runId: RUN_ID,
      after: 0,
    });

    expect(outcome).toBe("completed");
    expect(ids(sink)).toEqual([1, 2, 2]);
    expect(types(sink)).toEqual(["state.transitioned", "state.transitioned", "stream.closed"]);
    expect(sink.ended).toBe(true);
  });

  it("replays strictly after the reconnect cursor, so no event is delivered twice", async () => {
    const sink = new RecordingSink();

    await streamRunEvents(sink, deps([record(1), record(2), record(3)], "succeeded"), {
      runId: RUN_ID,
      after: 2,
    });

    expect(ids(sink)).toEqual([3, 3]);
  });

  it("withholds events outside the caller's audience", async () => {
    const sink = new RecordingSink();
    const events = [record(1), record(2, { audience: "operator", eventType: "cost.recorded" })];

    await streamRunEvents(sink, deps(events, "succeeded"), { runId: RUN_ID, after: 0 });

    expect(types(sink)).toEqual(["state.transitioned", "stream.closed"]);
  });

  it("waits for the consumer to drain before writing more", async () => {
    const sink = new RecordingSink();
    sink.backpressureAt.add(1);

    await streamRunEvents(sink, deps([record(1), record(2)], "succeeded"), {
      runId: RUN_ID,
      after: 0,
    });

    expect(sink.drains).toBe(1);
    expect(ids(sink)).toEqual([1, 2, 2]);
  });

  it("closes the stream when the caller's grant is revoked mid-stream", async () => {
    const sink = new RecordingSink();
    let calls = 0;
    const grant = async () => {
      calls += 1;
      return calls === 1 ? GRANT : null;
    };

    const outcome = await streamRunEvents(sink, deps([record(1)], "running", grant), {
      runId: RUN_ID,
      after: 0,
    });

    expect(outcome).toBe("authorization_revoked");
    expect(types(sink)).toEqual(["state.transitioned", "stream.revoked"]);
    expect(sink.ended).toBe(true);
  });

  it("never delivers anything when the grant is denied up front", async () => {
    const sink = new RecordingSink();

    const outcome = await streamRunEvents(
      sink,
      deps([record(1)], "running", async () => null),
      {
        runId: RUN_ID,
        after: 0,
      }
    );

    expect(outcome).toBe("authorization_revoked");
    expect(types(sink)).toEqual(["stream.revoked"]);
  });

  it("stops without writing when the client disconnected", async () => {
    const sink = new RecordingSink();
    sink.destroyed = true;

    const outcome = await streamRunEvents(sink, deps([record(1)], "running"), {
      runId: RUN_ID,
      after: 0,
    });

    expect(outcome).toBe("client_disconnected");
    expect(sink.chunks).toEqual([]);
  });

  it("polls again while the Run is still live, resuming from the last cursor", async () => {
    const sink = new RecordingSink();
    const events = [record(1)];
    const reader = new FakeEventReader(events);
    let polls = 0;

    const outcome = await streamRunEvents(
      sink,
      {
        events: reader,
        runs: {
          async find() {
            polls += 1;
            if (polls === 1) {
              events.push(record(2));
              return { status: "running" };
            }
            return { status: "succeeded" };
          },
        },
        authorize: async () => GRANT,
        sleep: noSleep,
      },
      { runId: RUN_ID, after: 0 }
    );

    expect(outcome).toBe("completed");
    expect(ids(sink)).toEqual([1, 2, 2]);
    expect(reader.calls.map((call) => call.after)).toEqual([0, 1]);
  });

  it("ends the stream when the Run cannot be read, without inventing an outcome", async () => {
    const sink = new RecordingSink();

    const outcome = await streamRunEvents(sink, deps([], null), { runId: RUN_ID, after: 0 });

    expect(outcome).toBe("run_not_found");
    expect(sink.chunks).toEqual([]);
    expect(sink.ended).toBe(true);
  });
});
