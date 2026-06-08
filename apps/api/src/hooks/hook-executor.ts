import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { HookAnalysisError, analyzeHook } from "./hook-analyzer.js";
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

  constructor(connectionString: string) {
    this.worker = new Worker(join(__dirname, "hook-worker.ts"), {
      execArgv: ["--import", "tsx"],
      workerData: { connectionString },
    });

    this.worker.on("message", (res: WorkerResponse) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      p.resolve(res);
    });

    this.worker.on("error", (err) => {
      for (const [id, p] of this.pending) {
        p.reject(err);
        this.pending.delete(id);
      }
    });
  }

  private send(req: Omit<WorkerRequest, "id">): Promise<WorkerResponse> {
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...req, id } satisfies WorkerRequest);
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

    const res = await this.send({ hookType: "before", hookSource, resourceType, record });
    if (!res.ok) {
      this.recordFailure(resourceType);
      throw new HookError(
        res.timedOut ? "hook timed out" : `hook error: ${res.error}`,
        res.timedOut
      );
    }
    this.recordSuccess(resourceType);
    return res.record;
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

  async close(): Promise<void> {
    await this.worker.terminate();
    for (const [id, p] of this.pending) {
      p.reject(new Error("executor closed"));
      this.pending.delete(id);
    }
  }
}
