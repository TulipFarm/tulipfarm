import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** JSON-RPC over Codex stdio; TulipFarm-free so subprocess races are unit-testable. */

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
  /** Queue turn-ending work after reply writes so teardown cannot overtake the answer. */
  onRequestReplied?(method: string, params: unknown): void;
  /** Called once on child exit/kill so notification consumers do not wait forever. */
  onClose?(error: Error): void;
}

/** How long teardown waits for queued writes to reach a child that may already be wedged. */
const FLUSH_GRACE_MS = 1_000;
/** How long a `SIGTERM`ed child gets before `SIGKILL`. */
const KILL_GRACE_MS = 2_000;
/** Bounded child stderr kept for the exit message; chatty children must not grow memory. */
const STDERR_TAIL_BYTES = 16_384;

export class CodexRpc {
  readonly process: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  /** Serialize writes so concurrent calls cannot split a JSON line in half. */
  private writeTail = Promise.resolve();
  /** Handle inbound lines in order so notifications cannot overtake their request. */
  private eventTail = Promise.resolve();
  private stderr = "";
  private closed = false;
  private closeError: Error | null = null;
  private readonly exited: Promise<void>;

  constructor(private readonly options: CodexRpcOptions) {
    // Run Codex's ESM shim under this Node so pnpm layout and minimal container PATH still work.
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

    // Child-exit writes emit stream `error` and callback failure; swallow the former to avoid a
    // process crash, while the callback/close path reports the cause.
    this.process.stdin?.on("error", () => {});

    // Spawn failure emits `error` and `close`; latch the first cause so it is reported once.
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
    // Best-effort bounded drain: let queued tool replies reach the pipe before kill, but callers
    // need a round trip for delivery guarantees.
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

    // Server requests block the turn; both outcomes must reply.
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
    // Do not let one failed write poison later writes.
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
