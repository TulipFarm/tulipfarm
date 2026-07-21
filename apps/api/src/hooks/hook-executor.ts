import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { analyzeHook, HookAnalysisError } from "./hook-analyzer.js";
import type { WorkerRequest, WorkerResponse } from "./types.js";

export class HookError extends Error {
  constructor(
    message: string,
    public readonly timedOut = false
  ) {
    super(message);
    this.name = "HookError";
  }
}

const CIRCUIT_BREAKER_THRESHOLD = 3;

export class HookExecutor {
  private readonly worker: Worker;
  private reqId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
  >();
  private readonly breaker = new Map<string, { failures: number; disabled: boolean }>();
  private workerError: Error | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    // The production image bundles the worker to a sibling hook-worker.cjs (the runtime ships
    // neither TS source nor tsx — see Dockerfile); dev/tests run the .ts source under tsx.
    const bundledWorker = join(__dirname, "hook-worker.cjs");
    const workerPath = existsSync(bundledWorker)
      ? bundledWorker
      : join(__dirname, "hook-worker.ts");
    this.worker = new Worker(workerPath, {
      execArgv: workerPath.endsWith(".ts") ? ["--import", "tsx"] : [],
      workerData: { connectionString },
    });

    this.worker.on("message", (res: WorkerResponse) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      p.resolve(res);
    });

    // Wrap raw worker errors as HookError so callers can handle them uniformly.
    // Also record the error so future send() calls reject immediately instead of hanging.
    this.worker.on("error", (err) => {
      this.workerError = err;
      const hookErr = new HookError(`hook worker error: ${err.message}`);
      for (const [id, p] of this.pending) {
        p.reject(hookErr);
        this.pending.delete(id);
      }
    });
  }

  private send(
    // Distributive omit: `Omit<union>` collapses the discriminated variants.
    req: WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never
  ): Promise<WorkerResponse> {
    if (this.closed) {
      return Promise.reject(new HookError("hook executor is closed"));
    }
    if (this.workerError) {
      return Promise.reject(new HookError(`hook worker error: ${this.workerError.message}`));
    }
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...req, id } as WorkerRequest);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private recordFailure(resourceType: string): void {
    const cb = this.breaker.get(resourceType) ?? { failures: 0, disabled: false };
    cb.failures++;
    if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      cb.disabled = true;
      console.error(
        `[hooks] CIRCUIT BREAKER: hook for resource "${resourceType}" disabled after ${cb.failures} consecutive failures`
      );
    }
    this.breaker.set(resourceType, cb);
  }

  private recordSuccess(resourceType: string): void {
    const cb = this.breaker.get(resourceType);
    if (cb) this.breaker.set(resourceType, { failures: 0, disabled: false });
  }

  private checkGuards(
    hookSource: string,
    resourceType: string,
    expectedHash?: string
  ): HookError | null {
    try {
      analyzeHook(hookSource);
    } catch (err) {
      if (err instanceof HookAnalysisError) {
        return new HookError(err.message);
      }
      throw err;
    }
    if (expectedHash) {
      const actual = createHash("sha256").update(hookSource).digest("hex");
      if (actual !== expectedHash) return new HookError("hook hash mismatch");
    }
    const cb = this.breaker.get(resourceType);
    if (cb?.disabled) return new HookError("hook disabled by circuit breaker");
    return null; // null = proceed
  }

  async runBeforeHook(
    hookSource: string,
    resourceType: string,
    record: Record<string, unknown>,
    expectedHash?: string
  ): Promise<Record<string, unknown>> {
    if (process.env.HOOKS_DISABLED === "true") return record;

    const guardErr = this.checkGuards(hookSource, resourceType, expectedHash);
    if (guardErr) throw guardErr;

    let res: WorkerResponse;
    try {
      res = await this.send({ hookType: "before", hookSource, resourceType, record });
    } catch (err) {
      this.recordFailure(resourceType);
      throw err instanceof HookError
        ? err
        : new HookError(`hook worker error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      this.recordFailure(resourceType);
      throw new HookError(
        res.timedOut ? "hook timed out" : `hook error: ${res.error}`,
        res.timedOut
      );
    }
    this.recordSuccess(resourceType);
    return "record" in res ? res.record : record;
  }

  async runAfterHook(
    hookSource: string,
    resourceType: string,
    record: Record<string, unknown>,
    expectedHash?: string
  ): Promise<void> {
    if (process.env.HOOKS_DISABLED === "true") return;

    const guardErr = this.checkGuards(hookSource, resourceType, expectedHash);
    if (guardErr) {
      console.warn(`[hooks] after hook skipped for ${resourceType}: ${guardErr.message}`);
      return;
    }

    const res = await this.send({ hookType: "after", hookSource, resourceType, record });
    if (!res.ok) {
      this.recordFailure(resourceType);
      console.warn(`[hooks] after hook error for ${resourceType}: ${res.error}`);
    } else {
      this.recordSuccess(resourceType);
    }
  }

  /**
   * Evaluate a routine data-flow expression in the sandbox (100ms, no host/fs/net).
   * Throws HookError on evaluation failure/timeout. `breakerKey` should identify the
   * routine (e.g. `routine:{slug}`) so a hot-looping expression trips its own breaker.
   */
  async runExpression(
    code: string,
    scope: Record<string, unknown>,
    breakerKey: string
  ): Promise<unknown> {
    try {
      analyzeHook(code);
    } catch (err) {
      if (err instanceof HookAnalysisError) throw new HookError(err.message);
      throw err;
    }
    const cb = this.breaker.get(breakerKey);
    if (cb?.disabled) throw new HookError("expression disabled by circuit breaker");

    let res: WorkerResponse;
    try {
      res = await this.send({ kind: "expression", code, scope });
    } catch (err) {
      this.recordFailure(breakerKey);
      throw err instanceof HookError
        ? err
        : new HookError(`hook worker error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      this.recordFailure(breakerKey);
      throw new HookError(
        res.timedOut ? "expression timed out" : `expression error: ${res.error}`,
        res.timedOut
      );
    }
    this.recordSuccess(breakerKey);
    return "value" in res ? res.value : undefined;
  }

  /**
   * Run a named function from a routine's hooks.ts (2s budget). Same static-analysis +
   * hash-integrity + circuit-breaker guards as resource hooks.
   */
  async runRoutineHook(
    hookSource: string,
    fnName: string,
    invocation: Record<string, unknown>,
    args: unknown,
    breakerKey: string,
    opts: { expectedHash?: string; optional?: boolean } = {}
  ): Promise<unknown> {
    if (process.env.HOOKS_DISABLED === "true") return undefined;

    const guardErr = this.checkGuards(hookSource, breakerKey, opts.expectedHash);
    if (guardErr) throw guardErr;

    let res: WorkerResponse;
    try {
      res = await this.send({
        kind: "routine-hook",
        hookSource,
        fnName,
        invocation,
        args,
        optional: opts.optional,
      });
    } catch (err) {
      this.recordFailure(breakerKey);
      throw err instanceof HookError
        ? err
        : new HookError(`hook worker error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      this.recordFailure(breakerKey);
      throw new HookError(
        res.timedOut ? "routine hook timed out" : `routine hook error: ${res.error}`,
        res.timedOut
      );
    }
    this.recordSuccess(breakerKey);
    return "value" in res ? res.value : undefined;
  }

  /**
   * Ask the worker to shut down gracefully (drain its isolate, close its pg pool, exit)
   * before falling back to a hard `terminate()`. A bare `terminate()` can kill the worker
   * while an isolate is still executing, which crashes the process with an isolated-vm
   * native assertion (`IsolateEnvironment::GetCurrent()`) instead of exiting cleanly.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const [id, p] of this.pending) {
      p.reject(new Error("executor closed"));
      this.pending.delete(id);
    }
    this.closePromise = this.shutdownWorker();
    await this.closePromise;
  }

  private shutdownWorker(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const hardTerminate = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.worker
          .terminate()
          .catch(() => {})
          .finally(resolve);
      };
      const timer = setTimeout(hardTerminate, 2000);

      this.worker.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });

      try {
        this.worker.postMessage({ type: "shutdown" });
      } catch {
        hardTerminate();
      }
    });
  }
}
