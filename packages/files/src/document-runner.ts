import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAX_DOCUMENT_BYTES, type OfficeDocumentFormat } from "./document-preview";
import type { ExtractionResult } from "./extract";

export const DOCUMENT_DEADLINE_MS = 10_000;
export const MAX_ACTIVE_DOCUMENTS = 2;
export const MAX_PENDING_DOCUMENTS = 32;

export type DocumentConversionFailure =
  | "deadline"
  | "cancelled"
  | "shutdown"
  | "saturated"
  | "native_load"
  | "crashed"
  | "protocol"
  | "conversion";

export class DocumentConversionError extends Error {
  readonly retryable = true;
  constructor(readonly code: DocumentConversionFailure) {
    super(`Local document conversion failed: ${code}`);
    this.name = "DocumentConversionError";
  }
}

interface Job {
  format: OfficeDocumentFormat | "pdf";
  bytes: Uint8Array;
  maxChars: number;
  resolve(result: ExtractionResult): void;
  reject(error: DocumentConversionError): void;
  signal?: AbortSignal;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
  result?: ExtractionResult;
  error?: DocumentConversionError;
}

function childEntrypoint(): string {
  const bundled = join(__dirname, "document-child.cjs");
  return existsSync(bundled) ? bundled : join(__dirname, "document-child.ts");
}

const REFUSALS = new Set([
  "unsupported_media_type",
  "needs_ocr",
  "unreadable",
  "encrypted",
  "resource_limit",
  "no_text_layer",
]);

function isResult(
  value: unknown,
  maxChars: number,
  format: OfficeDocumentFormat | "pdf"
): value is ExtractionResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if ("visual" in value && !isPdfVisual(value.visual)) return false;
  if (
    format === "pdf" &&
    (value.kind === "text" ||
      ("reason" in value && (value.reason === "needs_ocr" || value.reason === "no_text_layer"))) &&
    !("visual" in value)
  ) {
    return false;
  }
  if (value.kind === "text") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      value.text.length <= maxChars &&
      "truncated" in value &&
      typeof value.truncated === "boolean"
    );
  }
  return (
    value.kind === "refused" &&
    !("text" in value) &&
    "reason" in value &&
    typeof value.reason === "string" &&
    REFUSALS.has(value.reason)
  );
}

function isPdfVisual(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || value.kind !== "pdf" || !("pages" in value)) return false;
  return (
    Array.isArray(value.pages) &&
    value.pages.length > 0 &&
    value.pages.every(
      (page: unknown) =>
        typeof page === "object" &&
        page !== null &&
        "width" in page &&
        typeof page.width === "number" &&
        Number.isSafeInteger(page.width) &&
        page.width > 0 &&
        "height" in page &&
        typeof page.height === "number" &&
        Number.isSafeInteger(page.height) &&
        page.height > 0
    )
  );
}

/** Owns only fixed document children; a slot remains occupied until the OS reaps its child. */
export class DocumentRunner {
  private readonly active = new Set<Job>();
  private readonly pending: Job[] = [];
  private stopped = false;
  private readonly drainWaiters: (() => void)[] = [];

  convert(
    bytes: Uint8Array,
    maxChars: number,
    signal?: AbortSignal,
    format: OfficeDocumentFormat | "pdf" = "docx"
  ): Promise<ExtractionResult> {
    if (this.stopped) return Promise.reject(new DocumentConversionError("shutdown"));
    if (signal?.aborted) return Promise.reject(new DocumentConversionError("cancelled"));
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return Promise.resolve({ kind: "refused", reason: "resource_limit" });
    }
    if (this.active.size >= MAX_ACTIVE_DOCUMENTS && this.pending.length >= MAX_PENDING_DOCUMENTS) {
      return Promise.reject(new DocumentConversionError("saturated"));
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        format,
        bytes,
        maxChars,
        resolve,
        reject,
        signal,
        abort: () => this.stop(job, "cancelled"),
        timer: setTimeout(() => this.stop(job, "deadline"), DOCUMENT_DEADLINE_MS),
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (this.active.size < MAX_ACTIVE_DOCUMENTS) this.start(job);
      else this.pending.push(job);
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const job of [...this.pending, ...this.active]) this.stop(job, "shutdown");
    if (this.active.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private stop(job: Job, code: DocumentConversionFailure): void {
    job.error ??= new DocumentConversionError(code);
    if (job.child) {
      job.child.kill("SIGKILL");
    } else {
      const index = this.pending.indexOf(job);
      if (index >= 0) this.pending.splice(index, 1);
      this.finish(job);
    }
  }

  private start(job: Job): void {
    this.active.add(job);
    try {
      const child = fork(childEntrypoint(), [], {
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // No application credentials, native-library overrides, or hosted converter settings.
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      });
      job.child = child;
      child.once("error", () => {
        job.error ??= new DocumentConversionError("crashed");
        child.kill("SIGKILL");
      });
      child.once("close", () => this.finish(job));
      child.once("message", (message: unknown) => {
        if (isResult(message, job.maxChars, job.format)) job.result = message;
        else {
          const code =
            typeof message === "object" && message !== null && "code" in message
              ? message.code
              : undefined;
          job.error ??= new DocumentConversionError(
            code === "native_load" || code === "conversion" ? code : "protocol"
          );
        }
        child.kill("SIGKILL");
      });
      child.send({ bytes: job.bytes, format: job.format, maxChars: job.maxChars }, (error) => {
        if (error) this.stop(job, "crashed");
      });
    } catch {
      this.stop(job, "crashed");
    }
  }

  private finish(job: Job): void {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    this.active.delete(job);
    if (job.error) job.reject(job.error);
    else if (job.result) job.resolve(job.result);
    else job.reject(new DocumentConversionError("crashed"));
    if (!this.stopped && this.active.size < MAX_ACTIVE_DOCUMENTS) {
      const next = this.pending.shift();
      if (next) this.start(next);
    }
    if (this.active.size === 0) {
      for (const resolve of this.drainWaiters.splice(0)) resolve();
    }
  }
}

const documents = new DocumentRunner();

export function convertDocument(
  format: OfficeDocumentFormat | "pdf",
  bytes: Uint8Array,
  maxChars: number,
  signal?: AbortSignal
): Promise<ExtractionResult> {
  return documents.convert(bytes, maxChars, signal, format);
}

export function convertDocx(
  bytes: Uint8Array,
  maxChars: number,
  signal?: AbortSignal
): Promise<ExtractionResult> {
  return documents.convert(bytes, maxChars, signal);
}

export function shutdownDocumentConversions(): Promise<void> {
  return documents.shutdown();
}
