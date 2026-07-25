import { describe, expect, it } from "vitest";
import { type RunEventRecord, type RunStreamGrant, type SseSink, streamRunEvents } from "./events";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const GRANT: RunStreamGrant = { businessId: BUSINESS_ID, audiences: ["participant"] };

function record(sequence: number): RunEventRecord {
  return {
    sequence,
    eventType: "state.transitioned",
    audience: "participant",
    payload: { stateKey: `state-${sequence}` },
    occurredAt: "2026-07-25T10:00:00.000Z",
  };
}

/** Sink that drops the connection after a fixed number of frames, as a lost client would. */
class DroppingSink implements SseSink {
  readonly chunks: string[] = [];
  destroyed = false;
  ended = false;

  constructor(private readonly dropAfter = Number.POSITIVE_INFINITY) {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.chunks.length >= this.dropAfter) this.destroyed = true;
    return true;
  }

  async waitForDrain(): Promise<void> {}

  end(): void {
    this.ended = true;
  }
}

function deliveredIds(sink: DroppingSink): number[] {
  return sink.chunks
    .filter((chunk) => chunk.includes("event: state.transitioned"))
    .map((chunk) => Number(/^id: (\d+)/.exec(chunk)?.[1]));
}

const log = [record(1), record(2), record(3), record(4)];

const deps = (onList?: () => void) => ({
  events: {
    async list(
      _businessId: string,
      _runId: string,
      options: { after: number; audiences: readonly string[]; limit?: number }
    ) {
      onList?.();
      return log.filter((event) => event.sequence > options.after);
    },
  },
  runs: {
    async find() {
      return { status: "succeeded" };
    },
  },
  authorize: async () => GRANT,
  sleep: async () => {},
});

describe("Run event stream recovery", () => {
  it("resumes from the last delivered cursor with no gap and no duplicate", async () => {
    const dropped = new DroppingSink(2);

    const firstOutcome = await streamRunEvents(dropped, deps(), { runId: RUN_ID, after: 0 });
    expect(firstOutcome).toBe("client_disconnected");
    const seen = deliveredIds(dropped);
    expect(seen).toEqual([1, 2]);

    const reconnected = new DroppingSink();
    const secondOutcome = await streamRunEvents(reconnected, deps(), {
      runId: RUN_ID,
      after: seen[seen.length - 1],
    });

    expect(secondOutcome).toBe("completed");
    expect(deliveredIds(reconnected)).toEqual([3, 4]);
    expect([...seen, ...deliveredIds(reconnected)]).toEqual([1, 2, 3, 4]);
  });

  it("replays the whole log when a client reconnects without a cursor", async () => {
    const sink = new DroppingSink();

    await streamRunEvents(sink, deps(), { runId: RUN_ID, after: 0 });

    expect(deliveredIds(sink)).toEqual([1, 2, 3, 4]);
  });

  it("never reads events for a caller whose grant is gone, even mid-recovery", async () => {
    let listed = 0;
    const sink = new DroppingSink();

    const outcome = await streamRunEvents(
      sink,
      {
        ...deps(() => {
          listed += 1;
        }),
        authorize: async () => null,
      },
      { runId: RUN_ID, after: 2 }
    );

    expect(outcome).toBe("authorization_revoked");
    expect(listed).toBe(0);
    expect(deliveredIds(sink)).toEqual([]);
  });
});
