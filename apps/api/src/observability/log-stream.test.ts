import { Writable } from "node:stream";
import { BatchingLogSink, type LogEventRecord } from "@tulipfarm/observability";
import { describe, expect, it } from "vitest";
import { createLogTeeStream } from "./log-stream";

function harness() {
  const rows: LogEventRecord[] = [];
  const stdout: string[] = [];
  const sink = new BatchingLogSink({
    service: "api",
    writer: {
      insertMany: async (batch) => {
        rows.push(...batch);
      },
    },
    batchSize: 1000,
    maxBuffer: 1000,
  });
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout.push(chunk.toString());
      cb();
    },
  });
  return { rows, stdout, sink, stream: createLogTeeStream(sink, out) };
}

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

describe("createLogTeeStream", () => {
  it("passes every line through to stdout regardless of level", () => {
    const { stream, stdout } = harness();
    stream.write(line({ level: 30, time: 1, msg: "info line" }));
    stream.write(line({ level: 50, time: 2, msg: "error line" }));

    expect(stdout.join("")).toContain("info line");
    expect(stdout.join("")).toContain("error line");
  });

  it("captures error and fatal records only", async () => {
    const { stream, sink, rows } = harness();
    stream.write(line({ level: 30, time: 1, msg: "info" }));
    stream.write(line({ level: 40, time: 2, msg: "warn" }));
    stream.write(line({ level: 50, time: 3, msg: "error" }));
    stream.write(line({ level: 60, time: 4, msg: "fatal" }));
    await sink.flush();

    expect(rows.map((r) => [r.level, r.message])).toEqual([
      ["error", "error"],
      ["fatal", "fatal"],
    ]);
  });

  it("extracts the stack and error type from a serialized error", async () => {
    const { stream, sink, rows } = harness();
    stream.write(
      line({
        level: 50,
        time: 1,
        msg: "request failed",
        err: { type: "TypeError", message: "x is not a function", stack: "TypeError: x\n  at y" },
      })
    );
    await sink.flush();

    expect(rows[0].message).toBe("request failed");
    expect(rows[0].stack).toBe("TypeError: x\n  at y");
    expect(rows[0].attributes.errorType).toBe("TypeError");
  });

  it("falls back to the error message when the record has no msg", async () => {
    const { stream, sink, rows } = harness();
    stream.write(line({ level: 50, time: 1, err: { message: "bare throw", stack: "at z" } }));
    await sink.flush();

    expect(rows[0].message).toBe("bare throw");
  });

  it("carries correlation ids into their own columns", async () => {
    const { stream, sink, rows } = harness();
    stream.write(
      line({ level: 50, time: 1, msg: "m", reqId: "req-7", runId: "run-9", conversationId: "c-3" })
    );
    await sink.flush();

    expect(rows[0].requestId).toBe("req-7");
    expect(rows[0].runId).toBe("run-9");
    expect(rows[0].conversationId).toBe("c-3");
    // Correlation ids are columns, so they must not be duplicated into attributes.
    expect(rows[0].attributes.reqId).toBeUndefined();
  });

  it("keeps non-reserved fields as attributes and drops pino noise", async () => {
    const { stream, sink, rows } = harness();
    stream.write(line({ level: 50, time: 1, pid: 99, hostname: "h", msg: "m", route: "/chat" }));
    await sink.flush();

    expect(rows[0].attributes.route).toBe("/chat");
    expect(rows[0].attributes.pid).toBeUndefined();
    expect(rows[0].attributes.hostname).toBeUndefined();
  });

  it("reassembles a record split across chunk boundaries", async () => {
    const { stream, sink, rows } = harness();
    const whole = line({ level: 50, time: 1, msg: "split across writes" });
    stream.write(whole.slice(0, 12));
    stream.write(whole.slice(12));
    await sink.flush();

    expect(rows.map((r) => r.message)).toEqual(["split across writes"]);
  });

  it("handles several records arriving in one chunk", async () => {
    const { stream, sink, rows } = harness();
    stream.write(line({ level: 50, time: 1, msg: "a" }) + line({ level: 50, time: 2, msg: "b" }));
    await sink.flush();

    expect(rows.map((r) => r.message)).toEqual(["a", "b"]);
  });

  it("survives non-JSON output without losing later records", async () => {
    const { stream, sink, rows, stdout } = harness();
    stream.write("this is not json\n");
    stream.write(line({ level: 50, time: 1, msg: "after the bad line" }));
    await sink.flush();

    expect(stdout.join("")).toContain("this is not json");
    expect(rows.map((r) => r.message)).toEqual(["after the bad line"]);
  });
});
