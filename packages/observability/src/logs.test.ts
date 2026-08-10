import { describe, expect, it, vi } from "vitest";
import { BatchingLogSink, describeError, type LogEventRecord } from "./logs";

function collector() {
  const rows: LogEventRecord[] = [];
  return {
    rows,
    insertMany: async (batch: readonly LogEventRecord[]) => {
      rows.push(...batch);
    },
  };
}

function sink(overrides: Partial<ConstructorParameters<typeof BatchingLogSink>[0]> = {}) {
  const writer = overrides.writer ?? collector();
  return {
    writer: writer as ReturnType<typeof collector>,
    instance: new BatchingLogSink({
      service: "api",
      writer,
      batchSize: 1000,
      maxBuffer: 1000,
      ...overrides,
    }),
  };
}

describe("BatchingLogSink", () => {
  it("buffers records and writes them as one batch on flush", async () => {
    const { instance, writer } = sink();
    instance.capture({ level: "error", message: "first" });
    instance.capture({ level: "fatal", message: "second" });

    expect(writer.rows).toHaveLength(0);
    expect(instance.bufferedCount).toBe(2);

    await instance.flush();

    expect(writer.rows.map((r) => r.message)).toEqual(["first", "second"]);
    expect(writer.rows.every((r) => r.service === "api")).toBe(true);
    expect(instance.bufferedCount).toBe(0);
  });

  it("flushes automatically once the batch size is reached", async () => {
    const { instance, writer } = sink({ batchSize: 2 });
    instance.capture({ level: "error", message: "a" });
    instance.capture({ level: "error", message: "b" });

    await instance.flush();
    expect(writer.rows).toHaveLength(2);
  });

  it("drops the incoming record when the buffer is full, keeping the earliest", async () => {
    const { instance, writer } = sink({ maxBuffer: 2, batchSize: 1000 });
    instance.capture({ level: "error", message: "root-cause" });
    instance.capture({ level: "error", message: "second" });
    instance.capture({ level: "error", message: "cascade-noise" });

    expect(instance.droppedCount).toBe(1);

    await instance.flush();

    const messages = writer.rows.map((r) => r.message);
    expect(messages).toContain("root-cause");
    expect(messages).not.toContain("cascade-noise");
  });

  it("reports dropped records as a synthetic entry on the next flush", async () => {
    const { instance, writer } = sink({ maxBuffer: 1, batchSize: 1000 });
    instance.capture({ level: "error", message: "kept" });
    instance.capture({ level: "error", message: "lost" });

    await instance.flush();

    expect(writer.rows.some((r) => /dropped 1 record/.test(r.message))).toBe(true);
    expect(instance.droppedCount).toBe(0);
  });

  it("never throws when the writer fails, and does not requeue the batch", async () => {
    const onWriteError = vi.fn();
    const failing = { insertMany: vi.fn().mockRejectedValue(new Error("database is down")) };
    const { instance } = sink({ writer: failing, onWriteError });

    instance.capture({ level: "error", message: "boom" });
    await expect(instance.flush()).resolves.toBeUndefined();

    expect(onWriteError).toHaveBeenCalledWith(expect.stringContaining("database is down"));
    expect(instance.bufferedCount).toBe(0);

    // A retry would grow the buffer without bound while the database stays unavailable.
    await instance.flush();
    expect(failing.insertMany).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent flushes so a batch is never written twice", async () => {
    let resolveWrite: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writer = { insertMany: vi.fn().mockReturnValue(gate) };
    const { instance } = sink({ writer });

    instance.capture({ level: "error", message: "one" });
    const a = instance.flush();
    const b = instance.flush();
    resolveWrite?.();
    await Promise.all([a, b]);

    expect(writer.insertMany).toHaveBeenCalledTimes(1);
  });

  it("redacts protected attribute keys on the way in", async () => {
    const { instance, writer } = sink();
    instance.capture({
      level: "error",
      message: "auth failed",
      attributes: { authorization: "Bearer sk-live-123", route: "/api/v1/chat" },
    });
    await instance.flush();

    expect(writer.rows[0].attributes.authorization).toBe("[redacted]");
    expect(writer.rows[0].attributes.route).toBe("/api/v1/chat");
  });

  it("truncates a very long message rather than storing it whole", async () => {
    const { instance, writer } = sink();
    instance.capture({ level: "error", message: "x".repeat(20_000) });
    await instance.flush();

    expect(writer.rows[0].message.length).toBeLessThan(20_000);
    expect(writer.rows[0].message.endsWith("[truncated]")).toBe(true);
  });

  it("flushes what is buffered when stopped", async () => {
    const { instance, writer } = sink();
    instance.start();
    instance.capture({ level: "error", message: "on shutdown" });
    await instance.stop();

    expect(writer.rows.map((r) => r.message)).toEqual(["on shutdown"]);
  });

  it("does not return from stop() while a record captured mid-write is still buffered", async () => {
    // The shutdown path closes the connection pool the instant stop() resolves, so a record left
    // buffered here is lost — and it is the shutdown-path error an operator most needs.
    const written: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const writer = {
      insertMany: async (rows: readonly { message: string }[]) => {
        written.push(...rows.map((r) => r.message));
        if (first) {
          first = false;
          await gate;
        }
      },
    };
    const { instance } = sink({ writer, batchSize: 1 });

    instance.capture({ level: "error", message: "first" });
    // Arrives while the first write is in flight, so it lands in a buffer that write never covers.
    instance.capture({ level: "error", message: "second" });

    const stopped = instance.stop();
    release();
    await stopped;

    expect(written).toEqual(["first", "second"]);
    expect(instance.bufferedCount).toBe(0);
  });

  it("writes nothing when there is nothing buffered", async () => {
    const writer = { insertMany: vi.fn() };
    const { instance } = sink({ writer });
    await instance.flush();
    expect(writer.insertMany).not.toHaveBeenCalled();
  });
});

describe("describeError", () => {
  it("reads message and stack off an Error", () => {
    const result = describeError(new Error("kaboom"));
    expect(result.message).toBe("kaboom");
    expect(result.stack).toContain("kaboom");
  });

  it("handles a thrown string", () => {
    expect(describeError("just a string")).toEqual({ message: "just a string", stack: null });
  });

  it("handles a thrown non-Error object", () => {
    expect(describeError({ code: 42 }).message).toBe('{"code":42}');
  });

  it("survives a value that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});
