import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ConfiguredModelRef } from "@tulipfarm/schema";
import { APICallError } from "ai";
import { classifyProviderError } from "./provider-error";

/** Minimal logger surface for fallback events (pino/console compatible). */
export interface FallbackLogger {
  warn(msg: string): void;
  /** Falls back to `warn` when absent, so an existing caller need not be widened to keep compiling. */
  error?(msg: string): void;
}

/**
 * Which configured link actually served a call.
 *
 * A fallback chain that rate-limits through to a cheaper model must be billed at that model's
 * price. `modelId` on the chain is every link pipe-joined and cannot answer this, so the responder
 * is recorded here as the chain executes rather than inferred from the chain head.
 */
export interface ModelResponderRef {
  modelId?: string;
  configuredModel?: ConfiguredModelRef;
  attemptId?: number;
}

/** The chain link whose provider call actually began, including a failed final attempt. */
export interface ModelAttemptRef {
  modelId?: string;
  configuredModel?: ConfiguredModelRef;
}

export interface FallbackAttemptUsage {
  readonly attemptId: number;
  readonly modelId: string;
  readonly configuredModel?: ConfiguredModelRef;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface FallbackAttemptUsageRef {
  readonly attempts: FallbackAttemptUsage[];
}

export interface FallbackAttemptBudgetLease {
  settle(
    usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined
  ): Promise<void>;
}

export interface FallbackAttemptBudgetController {
  admit(input: {
    readonly attemptId: number;
    readonly modelId: string;
    readonly configuredModel?: ConfiguredModelRef;
  }): Promise<FallbackAttemptBudgetLease>;
}

export interface FallbackAttemptBudgetRef {
  current?: FallbackAttemptBudgetController;
}

/** Durable Run-budget infrastructure failed before or after a provider attempt. */
export class FallbackBudgetInfrastructureError extends Error {
  constructor(
    readonly operation: "reserve" | "settle",
    cause: unknown
  ) {
    super(`model provider attempt budget ${operation} failed`, { cause });
    this.name = "FallbackBudgetInfrastructureError";
  }
}

export interface FallbackCallLease {
  succeeded(): void;
  failed(reason: string): void;
  cancelled(): void;
  release(): void;
}

/** Per-link admission control shared across model chains in one process. */
export interface FallbackCallGate {
  acquire(provider: string, signal?: AbortSignal): Promise<FallbackCallLease>;
}

const noopLogger: FallbackLogger = { warn() {} };

/**
 * Bounds retries against the *same* link for a rate-limited call, before it counts as a breaker
 * failure and the chain advances. A 1-strike breaker (see `apps/worker/src/model-gate.ts`) turns a
 * single 429 into a full 30s shutout of a provider that is otherwise healthy; a short backoff here
 * gives a transient throttle a chance to clear without burning the link's one strike.
 */
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_MAX_DELAY_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds or an HTTP-date, per RFC 9110 §10.2.3; only the seconds form is common in practice. */
function retryAfterMs(err: unknown): number | undefined {
  if (!APICallError.isInstance(err)) return undefined;
  const header = err.responseHeaders?.["retry-after"];
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function rateLimitBackoffMs(err: unknown, attempt: number): number {
  const fromHeader = retryAfterMs(err);
  if (fromHeader !== undefined) return Math.min(fromHeader, RATE_LIMIT_MAX_DELAY_MS);
  const exponential = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(exponential, RATE_LIMIT_MAX_DELAY_MS) + Math.random() * 250;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Caller cancellation and budget-store faults end the request; provider failures may fall back. */
export function isHardFailure(err: unknown): boolean {
  return (
    isAbortError(err) ||
    err instanceof FallbackBudgetInfrastructureError ||
    (typeof err === "object" &&
      err !== null &&
      "reason" in err &&
      err.reason === "budget_exhausted")
  );
}

function errorReason(err: unknown): string {
  if (APICallError.isInstance(err)) return `${err.statusCode ?? "?"} ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function inBandError(error: unknown): unknown {
  return error ?? new Error("provider emitted an empty error stream part");
}

/**
 * Stream parts that carry nothing a participant could see.
 *
 * They are held back rather than forwarded, which keeps the chain free to switch links right up
 * to the first part that is real output.
 */
const MAX_UNCOMMITTED_PARTS = 128;

function nonEmptyDelta(part: LanguageModelV4StreamPart, legacyField: string): boolean {
  const value =
    "delta" in part
      ? part.delta
      : (part as unknown as Readonly<Record<string, unknown>>)[legacyField];
  return typeof value === "string" && value.length > 0;
}

function isSubstantiveOutput(part: LanguageModelV4StreamPart): boolean {
  switch (part.type) {
    case "text-delta":
      return nonEmptyDelta(part, "textDelta");
    case "reasoning-delta":
      return nonEmptyDelta(part, "reasoningDelta");
    case "tool-input-delta":
      return nonEmptyDelta(part, "argsTextDelta");
    case "tool-call":
    case "tool-result":
    case "tool-approval-request":
    case "file":
    case "reasoning-file":
    case "source":
    case "custom":
      return true;
    default:
      return false;
  }
}

/**
 * One terminal outcome per lease.
 *
 * `ProviderGate.acquire` consumes the breaker's single half-open probe, and the breaker resolves
 * it only on a terminal outcome. Reporting two — which a cancel racing a pending read can do —
 * corrupts health accounting, and reporting none leaves the probe outstanding forever, wedging
 * the provider shut with no call in flight to reopen it.
 */
function settleOnce(lease: FallbackCallLease | undefined): FallbackCallLease | undefined {
  if (lease === undefined) return undefined;
  let outcome = false;
  let released = false;
  return {
    succeeded: () => {
      if (outcome) return;
      outcome = true;
      lease.succeeded();
    },
    failed: (reason: string) => {
      if (outcome) return;
      outcome = true;
      lease.failed(reason);
    },
    cancelled: () => {
      if (outcome) return;
      outcome = true;
      lease.cancelled();
    },
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  };
}

function replayStream(
  parts: readonly LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function attemptUsage(
  parts: readonly LanguageModelV4StreamPart[]
): { inputTokens: number; outputTokens: number } | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const part of parts) {
    if (part.type !== "finish") continue;
    found = true;
    inputTokens += part.usage.inputTokens.total ?? 0;
    outputTokens += part.usage.outputTokens.total ?? 0;
  }
  return found ? { inputTokens, outputTokens } : undefined;
}

export class FallbackModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "fallback";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private budgetAttempt = 0;

  constructor(
    private readonly models: LanguageModelV4[],
    private readonly logger: FallbackLogger = noopLogger,
    /** Records which link served, so cost is attributed to the model that answered. */
    private readonly responder?: ModelResponderRef,
    private readonly gate?: FallbackCallGate,
    private readonly providerKeys: readonly string[] = models.map(
      (model) => `${model.provider}:${model.modelId}`
    ),
    private readonly attempted?: ModelAttemptRef,
    private readonly configuredModels: readonly (ConfiguredModelRef | undefined)[] = [],
    private readonly attemptUsage?: FallbackAttemptUsageRef,
    private readonly attemptBudget?: FallbackAttemptBudgetRef
  ) {
    const primary = models[0];
    if (!primary) throw new Error("FallbackModel requires at least one model");
    this.modelId = models.map((m) => m.modelId).join("|");
  }

  /** Marks a link as the responder the moment it commits, before any output is consumed. */
  private commit(index: number, model: LanguageModelV4, attemptId: number): void {
    if (this.responder === undefined) return;
    this.responder.modelId = model.modelId;
    this.responder.attemptId = attemptId;
    const configured = this.configuredModels[index];
    if (configured === undefined) delete this.responder.configuredModel;
    else this.responder.configuredModel = configured;
  }

  private attempt(index: number, model: LanguageModelV4): void {
    if (this.attempted === undefined) return;
    this.attempted.modelId = model.modelId;
    const configured = this.configuredModels[index];
    if (configured === undefined) delete this.attempted.configuredModel;
    else this.attempted.configuredModel = configured;
  }

  private recordAttemptUsage(
    attemptId: number,
    index: number,
    model: LanguageModelV4,
    parts: readonly LanguageModelV4StreamPart[],
    startedAt: number
  ): void {
    if (this.attemptUsage === undefined) return;
    const usage = attemptUsage(parts);
    this.attemptUsage.attempts.push({
      attemptId,
      modelId: model.modelId,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(this.configuredModels[index] === undefined
        ? {}
        : { configuredModel: this.configuredModels[index] }),
      ...(usage === undefined ? {} : usage),
    });
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    let lastError: unknown;
    for (const [index, model] of this.models.entries()) {
      let lease: FallbackCallLease | undefined;
      try {
        lease = settleOnce(
          await this.gate?.acquire(this.providerKey(index, model), options.abortSignal)
        );
        const admitted = await this.callWithRateLimitRetry(index, model, () =>
          model.doGenerate(options)
        );
        const generated = admitted.value;
        await admitted.budget?.settle({
          inputTokens: generated.usage.inputTokens.total ?? 0,
          outputTokens: generated.usage.outputTokens.total ?? 0,
        });
        lease?.succeeded();
        this.commit(index, model, admitted.attemptId);
        return generated;
      } catch (err) {
        if (isHardFailure(err)) {
          lease?.cancelled();
          throw err;
        }
        lease?.failed(classifyProviderError(err));
        lastError = err;
        this.logFallback(model, err);
      } finally {
        lease?.release();
      }
    }
    this.logExhausted(lastError);
    throw lastError;
  }

  /**
   * Retries a rate-limited call against the same link before it is treated as a link failure.
   * Any other error, or exhausting the retry budget, is rethrown unchanged for the caller's
   * existing failure handling (breaker strike + advance to the next link).
   */
  private async callWithRateLimitRetry<T>(
    index: number,
    model: LanguageModelV4,
    call: () => PromiseLike<T>
  ): Promise<{
    readonly value: T;
    readonly budget: FallbackAttemptBudgetLease | undefined;
    readonly attemptId: number;
    readonly startedAt: number;
  }> {
    for (let attempt = 0; ; attempt++) {
      const attemptId = this.budgetAttempt++;
      const budget = await this.attemptBudget?.current?.admit({
        attemptId,
        modelId: model.modelId,
        ...(this.configuredModels[index] === undefined
          ? {}
          : { configuredModel: this.configuredModels[index] }),
      });
      this.attempt(index, model);
      const startedAt = Date.now();
      try {
        return { value: await call(), budget, attemptId, startedAt };
      } catch (err) {
        this.recordAttemptUsage(attemptId, index, model, [], startedAt);
        await budget?.settle(undefined);
        if (isHardFailure(err)) throw err;
        if (
          classifyProviderError(err) !== "model_rate_limited" ||
          attempt >= RATE_LIMIT_MAX_RETRIES
        ) {
          throw err;
        }
        const delayMs = rateLimitBackoffMs(err, attempt);
        this.logger.warn(
          `[llm] rate limited, retrying provider=${model.provider} model=${model.modelId} attempt=${attempt + 1}/${RATE_LIMIT_MAX_RETRIES} delayMs=${Math.round(delayMs)}`
        );
        await sleep(delayMs);
      }
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    let lastError: unknown;
    for (const [index, model] of this.models.entries()) {
      let lease: FallbackCallLease | undefined;
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
      let budget: FallbackAttemptBudgetLease | undefined;
      let attemptId = -1;
      let startedAt = 0;
      try {
        lease = settleOnce(
          await this.gate?.acquire(this.providerKey(index, model), options.abortSignal)
        );
        const admitted = await this.callWithRateLimitRetry(index, model, () =>
          model.doStream(options)
        );
        result = admitted.value;
        budget = admitted.budget;
        attemptId = admitted.attemptId;
        startedAt = admitted.startedAt;
      } catch (err) {
        if (isHardFailure(err)) {
          lease?.cancelled();
          lease?.release();
          throw err;
        }
        lease?.failed(classifyProviderError(err));
        lease?.release();
        lastError = err;
        this.logFallback(model, err);
        continue;
      }

      const reader = result.stream.getReader();
      const head: LanguageModelV4StreamPart[] = [];
      let ended = false;
      let sawError = false;
      let firstError: unknown;
      try {
        // Read only as far as the first part that is real output. Draining the whole stream here
        // is what made time-to-first-token equal the provider's time-to-last-token.
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            break;
          }
          if (chunk.value.type === "error") {
            sawError = true;
            firstError ??= inBandError(chunk.value.error);
            continue;
          }
          head.push(chunk.value);
          if (!sawError && isSubstantiveOutput(chunk.value)) break;
          if (head.length >= MAX_UNCOMMITTED_PARTS) {
            throw new Error("provider emitted too many stream frames before output");
          }
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        const usage = attemptUsage(head);
        this.recordAttemptUsage(attemptId, index, model, head, startedAt);
        if (isHardFailure(err)) {
          lease?.cancelled();
          lease?.release();
          await budget?.settle(usage);
          throw err;
        }
        lease?.failed(classifyProviderError(err));
        lease?.release();
        await budget?.settle(usage);
        lastError = err;
        this.logFallback(model, err);
        continue;
      }

      if (sawError) {
        reader.cancel(firstError).catch(() => {});
        const usage = attemptUsage(head);
        this.recordAttemptUsage(attemptId, index, model, head, startedAt);
        lease?.failed(classifyProviderError(firstError));
        lease?.release();
        await budget?.settle(usage);
        lastError = firstError;
        this.logFallback(model, firstError);
        continue;
      }

      this.commit(index, model, attemptId);
      if (ended) {
        lease?.succeeded();
        lease?.release();
        await budget?.settle(attemptUsage(head));
        return { ...result, stream: replayStream(head) };
      }
      return {
        ...result,
        stream: this.committedStream(head, reader, lease, budget, options.abortSignal),
      };
    }
    this.logExhausted(lastError);
    throw lastError;
  }

  /**
   * The committed link's stream, forwarded as it arrives rather than after it completes.
   *
   * The lease is held until the stream ends: it is what bounds in-flight calls per provider, so
   * releasing it at commit would make the cap count only the wait before the first token. Every
   * exit — end, failure, cancel, or the caller's signal aborting — has to settle it, or the slot
   * and the breaker's half-open probe are never returned.
   */
  private committedStream(
    head: readonly LanguageModelV4StreamPart[],
    reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
    lease: FallbackCallLease | undefined,
    budget: FallbackAttemptBudgetLease | undefined,
    signal: AbortSignal | undefined
  ): ReadableStream<LanguageModelV4StreamPart> {
    const { logger, modelId } = this;
    let detachAbort = () => {};
    let committedError: unknown;
    const parts = [...head];

    // The caller walking away says nothing about provider health. Cancellation settles the lease
    // without counting a provider failure, including the breaker's single half-open probe.
    const abandoned = async () => {
      detachAbort();
      lease?.cancelled();
      lease?.release();
      await budget?.settle(attemptUsage(parts));
    };

    if (signal?.aborted === true) {
      abandoned().catch((error) => {
        (logger.error ?? logger.warn)(
          `[llm] budget settlement failed after cancellation models=${modelId} reason=${errorReason(error)}`
        );
      });
      reader.cancel(signal.reason).catch(() => {});
    } else if (signal !== undefined) {
      const onAbort = () => {
        abandoned().catch((error) => {
          (logger.error ?? logger.warn)(
            `[llm] budget settlement failed after cancellation models=${modelId} reason=${errorReason(error)}`
          );
        });
        reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbort);
    }

    return new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of head) controller.enqueue(part);
      },
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          detachAbort();
          if (isHardFailure(err)) {
            lease?.cancelled();
          } else {
            lease?.failed(classifyProviderError(err));
            logger.warn(
              `[llm] stream failed after commit models=${modelId} reason=${errorReason(err)}`
            );
          }
          lease?.release();
          try {
            await budget?.settle(attemptUsage(parts));
          } catch (settlementError) {
            controller.error(settlementError);
            return;
          }
          controller.error(err);
          return;
        }

        if (chunk.done) {
          detachAbort();
          if (committedError === undefined) lease?.succeeded();
          lease?.release();
          try {
            await budget?.settle(attemptUsage(parts));
          } catch (error) {
            controller.error(error);
            return;
          }
          controller.close();
          return;
        }
        parts.push(chunk.value);
        if (chunk.value.type === "error" && committedError === undefined) {
          committedError = inBandError(chunk.value.error);
          lease?.failed(classifyProviderError(committedError));
          logger.warn(
            `[llm] stream failed after commit models=${modelId} reason=${errorReason(committedError)}`
          );
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return Promise.all([reader.cancel(reason), abandoned()]).then(() => undefined);
      },
    });
  }

  private providerKey(index: number, model: LanguageModelV4): string {
    return this.providerKeys[index] ?? model.provider;
  }

  private logFallback(model: LanguageModelV4, err: unknown): void {
    this.logger.warn(
      `[llm] fallback provider=${model.provider} model=${model.modelId} reason=${errorReason(err)}`
    );
  }

  private logExhausted(err: unknown): void {
    // Terminal for this call, not routine — captured at error level so it reaches the durable log
    // store instead of vanishing with the rest of `warn`.
    (this.logger.error ?? this.logger.warn)(
      `[llm] all providers exhausted models=${this.modelId} reason=${errorReason(err)}`
    );
  }
}
