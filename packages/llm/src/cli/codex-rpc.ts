import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Newline-delimited JSON-RPC 2.0 over `codex app-server` stdio.
 *
 * Ported from `qm/src/harness/codex-app-server.ts`. Codex exposes no in-process SDK — unlike
 * Claude Code, whose `@anthropic-ai/claude-agent-sdk` owns the subprocess — so this adapter speaks
 * the wire protocol itself. Kept deliberately free of TulipFarm concepts so the parts that can
 * strand a turn (a write racing a close, a half-read line, a child that ignores SIGTERM) are
 * testable on their own, against a fake binary.
 */

export class CodexRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRpcError";
  }
}

type JsonRpcId = number | string;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexRpcOptions {
  /** `bin/codex.js` from `@openai/codex`, run under this process's own Node. */
  readonly scriptPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown): Promise<unknown>;
  /**
   * The reply to a server request has been written. Anything that ends the turn belongs here rather
   * than inside `onRequest`: writes are serialized, so work started before the reply is queued gets
   * ordered ahead of it, and a teardown that overtakes the reply leaves the server waiting on an
   * answer that was never flushed.
   */
  onRequestReplied?(method: string, params: unknown): void;
  /**
   * The child is gone. Called exactly once, whether it exited on its own or was killed by
   * `close()`. Without it a consumer waiting on notifications would wait forever for a turn that
   * can no longer produce any — the pending-request map is failed on exit, but a turn is driven by
   * notifications, and those simply stop.
   */
  onClose?(error: Error): void;
}

/** How long teardown waits for queued writes to reach a child that may already be wedged. */
const FLUSH_GRACE_MS = 1_000;
/** How long a `SIGTERM`ed child gets before `SIGKILL`. */
const KILL_GRACE_MS = 2_000;
/** Bytes of the child's stderr kept for the exit message. Bounded: a chatty child must not grow unboundedly. */
const STDERR_TAIL_BYTES = 16_384;

export class CodexRpc {
  readonly process: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  /** Writes are serialized: two concurrent `write`s can interleave and split a JSON line in half. */
  private writeTail = Promise.resolve();
  /** Inbound lines are handled in order, so a notification cannot overtake the request it belongs to. */
  private eventTail = Promise.resolve();
  private stderr = "";
  private closed = false;
  private closeError: Error | null = null;
  private readonly exited: Promise<void>;

  constructor(private readonly options: CodexRpcOptions) {
    // `bin/codex.js` is an ESM shim that locates the native binary for this platform. Running it
    // under `process.execPath` rather than relying on a shebang or a `.bin` shim keeps it working
    // in a container where PATH is minimal and node_modules layout is pnpm's, not npm's.
    this.process = spawn(process.execPath, [options.scriptPath, "app-server"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let markExited!: () => void;
    this.exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });

    const stdout = this.process.stdout;
    if (stdout) {
      createInterface({ input: stdout }).on("line", (line) => {
        this.eventTail = this.eventTail
          .then(() => this.receive(line))
          .catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.failAll(failure);
            this.process.kill("SIGTERM");
          });
      });
    }

    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_TAIL_BYTES);
    });

    // A write to a child that has already gone emits EPIPE on the stream as well as failing the
    // write callback. An unhandled `error` event on a stream is fatal to the whole process, so a
    // Codex subprocess dying at the wrong moment would take the API down with it. The failed write
    // is already reported through the callback, and the real cause through `closeError`.
    this.process.stdin?.on("error", () => {});

    // A spawn failure emits **both** `error` and `close`, so the notification is latched: the
    // caller is told once, with the first (more specific) cause, rather than twice with the
    // second overwriting the reason the child never started.
    let notified = false;
    const notifyClosed = (error: Error) => {
      this.closed = true;
      if (!notified) this.closeError = error;
      this.failAll(error);
      if (!notified) {
        notified = true;
        this.options.onClose?.(error);
      }
      markExited();
    };

    this.process.once("error", (error) => notifyClosed(error));

    this.process.once("close", (code, signal) => {
      const tail = this.stderr.trim();
      notifyClosed(
        new Error(
          `codex app-server exited (${code ?? signal ?? "unknown"})${tail ? `: ${tail}` : ""}`
        )
      );
    });
  }

  /** Why the child is gone, or `null` while it is still running. */
  error(): Error | null {
    return this.closeError;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "tulipfarm", title: "TulipFarm", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("codex app-server is closed"));
    }
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    void this.send({ id, method, ...(params === undefined ? {} : { params }) }).catch(
      (error: unknown) => {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exited;
      return;
    }
    // Give queued writes a chance to leave before the child is killed. A turn ends the instant a
    // tool call is captured, so the reply to the server's `item/tool/call` request is written on
    // the way out — killing first would guarantee it never left at all.
    //
    // This is best-effort and deliberately not the delivery guarantee: a write resolves when the
    // OS accepts it into the pipe, not when the child has read it, so anything that *must* be
    // processed has to be confirmed by the caller with a round trip (see `turn/interrupt` in
    // `codex.ts`). Draining is a loop rather than a single await because answering one message can
    // queue the next, and bounded because a child that stopped reading must not hold teardown open.
    const deadline = Date.now() + FLUSH_GRACE_MS;
    for (let tail = this.writeTail; Date.now() < deadline; tail = this.writeTail) {
      await Promise.race([
        tail.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, deadline - Date.now()).unref?.()),
      ]);
      if (this.writeTail === tail) break;
    }
    this.closed = true;
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), KILL_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  private async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      throw new Error(`codex app-server emitted invalid JSON: ${line.slice(0, 500)}`);
    }

    // A response: has an id, carries no method.
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new CodexRpcError(
            `codex ${message.error.code ?? "error"}: ${
              message.error.message ?? JSON.stringify(message.error.data)
            }`
          )
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;

    if (message.id === undefined) {
      this.options.onNotification(message.method, message.params);
      return;
    }

    // A request from the server. It blocks the turn until answered, so both outcomes must reply.
    try {
      const result = await this.options.onRequest(message.method, message.params);
      await this.send({ id: message.id, result });
    } catch (error) {
      await this.send({
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
    this.options.onRequestReplied?.(message.method, message.params);
  }

  private send(message: JsonRpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const operation = this.writeTail.then(async () => {
      const stdin = this.process.stdin;
      if (this.closed || !stdin?.writable) throw new Error("codex app-server stdin is closed");
      await new Promise<void>((resolve, reject) => {
        stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    });
    // The tail must not inherit the rejection, or one failed write poisons every later one.
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
