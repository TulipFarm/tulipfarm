import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DOCUMENT_BYTES } from "./document-preview";
import {
  DOCUMENT_DEADLINE_MS,
  DocumentRunner,
  MAX_ACTIVE_DOCUMENTS,
  MAX_PENDING_DOCUMENTS,
} from "./document-runner";
import { docxParagraph, externalDocx } from "./docx-fixture.test-support";
import { externalPdf } from "./pdf-fixture.test-support";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

class ControlledChild extends EventEmitter {
  kill = vi.fn(() => true);
  send = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(fork).mockRestore();
});

describe("bounded native child ownership", () => {
  it("preserves Markdown whitespace and validated PDF dimensions across IPC", async () => {
    const child = new ControlledChild();
    vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
    const runner = new DocumentRunner();
    const result = runner.convert(externalPdf("layout"), 100, undefined, "pdf");
    const converted = {
      kind: "text",
      text: "# Heading\n\n| A | B |\n| --- | --- |\n\n```\n    keep  spacing\n```\n",
      truncated: false,
      visual: { kind: "pdf", pages: [{ width: 1224, height: 1584 }] },
    };
    child.emit("message", converted);
    child.emit("close", null, "SIGKILL");
    await expect(result).resolves.toEqual(converted);
    const spawnOptions = vi.mocked(fork).mock.calls[0]?.[2];
    expect(spawnOptions?.env).not.toHaveProperty("FIRECRAWL_API_KEY");
    expect(spawnOptions?.env).not.toHaveProperty("FIRECRAWL_API_URL");
    await runner.shutdown();
  });

  it("admits exactly two active and 32 pending jobs, and reuses slots only after reaping", async () => {
    const children: ControlledChild[] = [];
    vi.mocked(fork).mockImplementation(() => {
      const child = new ControlledChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const runner = new DocumentRunner();
    const outcomes = Array.from({ length: MAX_ACTIVE_DOCUMENTS + MAX_PENDING_DOCUMENTS }, () =>
      runner.convert(new Uint8Array(), 10).catch((error: unknown) => error)
    );
    expect(children).toHaveLength(2);
    await expect(runner.convert(new Uint8Array(), 10)).rejects.toMatchObject({
      code: "saturated",
      retryable: true,
    });
    children[0]?.emit("message", { kind: "text", text: "first", truncated: false });
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(children).toHaveLength(2);
    children[0]?.emit("close", null, "SIGKILL");
    expect(children).toHaveLength(3);
    const shutdown = runner.shutdown();
    expect(children[1]?.kill).toHaveBeenCalledWith("SIGKILL");
    children[1]?.emit("close", null, "SIGKILL");
    children[2]?.emit("close", null, "SIGKILL");
    await shutdown;
    await Promise.all(outcomes);
    await expect(runner.convert(new Uint8Array(), 10)).rejects.toMatchObject({ code: "shutdown" });
  });

  it("does not mislabel native-load failures or crashes as unreadable Files", async () => {
    const children: ControlledChild[] = [];
    vi.mocked(fork).mockImplementation(() => {
      const child = new ControlledChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const runner = new DocumentRunner();
    const load = runner.convert(new Uint8Array(), 10);
    const rejectedLoad = expect(load).rejects.toMatchObject({ code: "native_load" });
    children[0]?.emit("message", { kind: "failure", code: "native_load" });
    children[0]?.emit("close", null, "SIGKILL");
    await rejectedLoad;
    const crash = runner.convert(new Uint8Array(), 10);
    const rejectedCrash = expect(crash).rejects.toMatchObject({ code: "crashed" });
    children[1]?.emit("close", 1, null);
    await rejectedCrash;
    await runner.shutdown();
  });

  it("removes cancelled queued work without spawning it", async () => {
    const children: ControlledChild[] = [];
    vi.mocked(fork).mockImplementation(() => {
      const child = new ControlledChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const runner = new DocumentRunner();
    const active = [runner.convert(new Uint8Array(), 10), runner.convert(new Uint8Array(), 10)].map(
      (result) => result.catch((error: unknown) => error)
    );
    const controller = new AbortController();
    const queued = runner.convert(new Uint8Array(), 10, controller.signal);
    const following = runner.convert(new Uint8Array(), 10).catch((error: unknown) => error);
    const rejected = expect(queued).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await rejected;
    expect(children).toHaveLength(2);
    const stopped = runner.shutdown();
    for (const child of children) child.emit("close", null, "SIGKILL");
    await stopped;
    await Promise.all(active);
    await following;
    expect(children).toHaveLength(2);
  });

  it.each([MAX_DOCUMENT_BYTES - 1, MAX_DOCUMENT_BYTES])(
    "admits input of %i bytes",
    async (size) => {
      const child = new ControlledChild();
      vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
      const runner = new DocumentRunner();
      const result = runner.convert(new Uint8Array(size), 10);
      child.emit("message", { kind: "refused", reason: "unreadable" });
      child.emit("close", null, "SIGKILL");
      await expect(result).resolves.toMatchObject({ reason: "unreadable" });
      expect(child.send).toHaveBeenCalled();
      await runner.shutdown();
    }
  );

  it("refuses input above 25 MiB without spawning a native child", async () => {
    const runner = new DocumentRunner();
    const calls = vi.mocked(fork).mock.calls.length;
    await expect(runner.convert(new Uint8Array(MAX_DOCUMENT_BYTES + 1), 10)).resolves.toEqual({
      kind: "refused",
      reason: "resource_limit",
    });
    expect(vi.mocked(fork).mock.calls).toHaveLength(calls);
    await runner.shutdown();
  });

  it.each(["docx", "pdf"] as const)(
    "kills and reaps a real %s child on deadline, then converts the next document",
    async (format) => {
      vi.useFakeTimers();
      const runner = new DocumentRunner();
      const conversion = runner.convert(
        format === "pdf" ? externalPdf() : externalDocx(docxParagraph("Deadline fixture")),
        100,
        undefined,
        format
      );
      const rejected = expect(conversion).rejects.toMatchObject({ code: "deadline" });
      const child = vi.mocked(fork).mock.results.at(-1)?.value as ChildProcess;
      const pid = child.pid;
      expect(pid).toBeTypeOf("number");
      vi.advanceTimersByTime(DOCUMENT_DEADLINE_MS);
      await rejected;
      if (pid === undefined) throw new Error("Expected child pid");
      expect(() => process.kill(pid, 0)).toThrow();
      vi.useRealTimers();
      await expect(
        runner.convert(externalDocx(docxParagraph("Next conversion succeeds")), 100)
      ).resolves.toMatchObject({
        kind: "text",
        text: "Next conversion succeeds",
        truncated: false,
      });
      await runner.shutdown();
    }
  );

  it("shares Office capacity with PDFs and rejects invalid PDF dimensions at the IPC boundary", async () => {
    const children: ControlledChild[] = [];
    vi.mocked(fork).mockImplementation(() => {
      const child = new ControlledChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const runner = new DocumentRunner();
    const office = runner.convert(new Uint8Array(), 10).catch((error: unknown) => error);
    const pdf = runner.convert(externalPdf("scan"), 10, undefined, "pdf");
    const rejected = expect(pdf).rejects.toMatchObject({ code: "protocol" });
    const pending = runner
      .convert(externalPdf(), 10, undefined, "pdf")
      .catch((error: unknown) => error);
    expect(children).toHaveLength(2);
    expect(children[1]?.send).toHaveBeenCalledWith(
      expect.objectContaining({ format: "pdf" }),
      expect.any(Function)
    );
    children[1]?.emit("message", {
      kind: "refused",
      reason: "needs_ocr",
      visual: { kind: "pdf", pages: [{ width: Number.POSITIVE_INFINITY, height: 100 }] },
    });
    children[1]?.emit("close", null, "SIGKILL");
    await rejected;
    const stopped = runner.shutdown();
    children[0]?.emit("close", null, "SIGKILL");
    children[2]?.emit("close", null, "SIGKILL");
    await stopped;
    await Promise.all([office, pending]);
  });

  it.each(["cancel", "shutdown"] as const)("reaps an active native child on %s", async (action) => {
    const runner = new DocumentRunner();
    const controller = new AbortController();
    const result = runner.convert(
      externalDocx(docxParagraph("Stop fixture")),
      100,
      controller.signal
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: action === "cancel" ? "cancelled" : "shutdown",
    });
    const child = vi.mocked(fork).mock.results.at(-1)?.value as ChildProcess;
    const stopped = action === "shutdown" ? runner.shutdown() : undefined;
    if (action === "cancel") controller.abort();
    await rejected;
    await stopped;
    const pid = child.pid;
    if (pid === undefined) throw new Error("Expected child pid");
    expect(() => process.kill(pid, 0)).toThrow();
    await runner.shutdown();
  });
});
