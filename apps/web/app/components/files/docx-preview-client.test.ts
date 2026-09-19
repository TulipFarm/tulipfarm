import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCX_PREVIEW_DEADLINE_MS,
  DocxPreviewFailure,
  previewDocument,
  previewDocx,
} from "./docx-preview-client";

class PreviewWorker {
  static instances: PreviewWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions
  ) {
    PreviewWorker.instances.push(this);
  }
}

function lastWorker(): PreviewWorker {
  const worker = PreviewWorker.instances.at(-1);
  if (!worker) throw new Error("Expected a preview worker");
  return worker;
}

describe("local Word preview lifecycle", () => {
  beforeEach(() => {
    PreviewWorker.instances = [];
    vi.stubGlobal("Worker", PreviewWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["docx", "xlsx", "pptx"] as const)(
    "loads a shared module worker lazily and transfers a copy (%s)",
    async (format) => {
      expect(PreviewWorker.instances).toHaveLength(0);
      const bytes = new Uint8Array([80, 75, 3, 4]);
      const pending = previewDocument(bytes, new AbortController().signal, format);
      const worker = lastWorker();
      expect(worker.options.type).toBe("module");
      const [request, transfers] = worker.postMessage.mock.calls[0] ?? [];
      expect(request.bytes).toEqual(bytes);
      expect(request.format).toBe(format);
      expect(request.bytes.buffer).not.toBe(bytes.buffer);
      expect(transfers).toEqual([request.bytes.buffer]);
      const preview = { blocks: [], truncated: false };
      worker.onmessage?.(new MessageEvent("message", { data: { kind: "ready", preview } }));
      await expect(pending).resolves.toEqual(preview);
      expect(bytes).toEqual(new Uint8Array([80, 75, 3, 4]));
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("terminates synchronous conversion on its deadline and permits the next preview", async () => {
    const pending = previewDocx(new Uint8Array([1]), new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    const worker = lastWorker();
    await vi.advanceTimersByTimeAsync(DOCX_PREVIEW_DEADLINE_MS);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const next = previewDocx(new Uint8Array([2]), new AbortController().signal);
    lastWorker().onmessage?.(
      new MessageEvent("message", {
        data: { kind: "ready", preview: { blocks: [], truncated: false } },
      })
    );
    await expect(next).resolves.toMatchObject({ truncated: false });
  });

  it("terminates cancelled work and ignores a queued stale reply", async () => {
    const controller = new AbortController();
    const pending = previewDocx(new Uint8Array([1]), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const worker = lastWorker();
    const queuedReply = worker.onmessage;
    controller.abort();
    queuedReply?.(
      new MessageEvent("message", {
        data: { kind: "ready", preview: { blocks: [], truncated: false } },
      })
    );
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an already cancelled preview", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(previewDocx(new Uint8Array(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(PreviewWorker.instances).toHaveLength(0);
  });

  it("distinguishes damaged documents from an unavailable local converter", async () => {
    const malformed = previewDocx(new Uint8Array(), new AbortController().signal);
    lastWorker().onmessage?.(
      new MessageEvent("message", { data: { kind: "failed", code: "malformed" } })
    );
    await expect(malformed).rejects.toEqual(new DocxPreviewFailure("malformed"));
    const unavailable = previewDocx(new Uint8Array(), new AbortController().signal);
    lastWorker().onerror?.(new ErrorEvent("error", { message: "private vendor details" }));
    await expect(unavailable).rejects.toEqual(new DocxPreviewFailure("unavailable"));
    expect(lastWorker().terminate).toHaveBeenCalledOnce();
  });
});
