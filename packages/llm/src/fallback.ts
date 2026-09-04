import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
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
}

/** The chain link whose provider call actually began, including a failed final attempt. */
export interface ModelAttemptRef {
  modelId?: string;
}

export interface FallbackCallLease {
  succeeded(): void;
  failed(reason: string): void;
  release(): void;
}

/** Per-link admission control shared across model chains in one process. */
export interface FallbackCallGate {
  acquire(provider: string): Promise<FallbackCallLease>;
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

/** Caller cancellation ends the whole request; every model/provider failure advances the chain. */
export function isHardFailure(err: unknown): boolean {
  return isAbortError(err);
}

function errorReason(err: unknown): string {
  if (APICallError.isInstance(err)) return `${err.statusCode ?? "?"} ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Stream parts that carry nothing a participant could see.
 *
 * They are held back rather than forwarded, which keeps the chain free to switch links right up
 * to the first part that is real output.
 */
const PRELUDE_PARTS: ReadonlySet<string> = new Set(["stream-start", "response-metadata"]);

/**
 * One terminal outcome per lease.
 *
 * `ProviderGate.acquire` consumes the breaker's single half-open probe, and the breaker resolves
 * it only on `succeeded`/`failed`. Reporting both — which a cancel racing a pending read does —
 * corrupts the failure count, and reporting neither leaves the probe outstanding forever, wedging
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

export class FallbackModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "fallback";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    private readonly models: LanguageModelV4[],
    private readonly logger: FallbackLogger = noopLogger,
    /** Records which link served, so cost is attributed to the model that answered. */
    private readonly responder?: ModelResponderRef,
    private readonly gate?: FallbackCallGate,
    private readonly providerKeys: readonly string[] = models.map((model) => model.provider),
    private readonly attempted?: ModelAttemptRef
  ) {
    const primary = models[0];
    if (!primary) throw new Error("FallbackModel requires at least one model");
    this.modelId = models.map((m) => m.modelId).join("|");
  }

  /** Marks a link as the responder the moment it commits, before any output is consumed. */
  private commit(model: LanguageModelV4): void {
    if (this.responder !== undefined) this.responder.modelId = model.modelId;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    let lastError: unknown;
    for (const [index, model] of this.models.entries()) {
      let lease: FallbackCallLease | undefined;
      try {
        lease = settleOnce(await this.gate?.acquire(this.providerKey(index, model)));
        if ((lease !== undefined || this.gate === undefined) && this.attempted !== undefined) {
          this.attempted.modelId = model.modelId;
        }
        const generated = await this.callWithRateLimitRetry(model, () => model.doGenerate(options));
        lease?.succeeded();
        this.commit(model);
        return generated;
      } catch (err) {
        if (isHardFailure(err)) throw err;
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
    model: LanguageModelV4,
    call: () => PromiseLike<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
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
      try {
        lease = settleOnce(await this.gate?.acquire(this.providerKey(index, model)));
        if ((lease !== undefined || this.gate === undefined) && this.attempted !== undefined) {
          this.attempted.modelId = model.modelId;
        }
        result = await this.callWithRateLimitRetry(model, () => model.doStream(options));
      } catch (err) {
        if (isHardFailure(err)) {
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
      try {
        // Read only as far as the first part that is real output. Draining the whole stream here
        // is what made time-to-first-token equal the provider's time-to-last-token.
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            break;
          }
          head.push(chunk.value);
          if (!PRELUDE_PARTS.has(chunk.value.type)) break;
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        if (isHardFailure(err)) {
          lease?.release();
          throw err;
        }
        lease?.failed(classifyProviderError(err));
        lease?.release();
        lastError = err;
        this.logFallback(model, err);
        continue;
      }

      this.commit(model);
      if (ended) {
        lease?.succeeded();
        lease?.release();
        return { ...result, stream: replayStream(head) };
      }
      return { ...result, stream: this.committedStream(head, reader, lease, options.abortSignal) };
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
    signal: AbortSignal | undefined
  ): ReadableStream<LanguageModelV4StreamPart> {
    const { logger, modelId } = this;
    let detachAbort = () => {};

    // The caller walking away says nothing about provider health, but the breaker has only two
    // verbs and an unsettled half-open probe never reopens on its own. The provider was answering
    // when we left, so that is what it is told.
    const abandoned = () => {
      detachAbort();
      lease?.succeeded();
      lease?.release();
    };

    if (signal?.aborted === true) {
      abandoned();
      reader.cancel(signal.reason).catch(() => {});
    } else if (signal !== undefined) {
      const onAbort = () => {
        abandoned();
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
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            detachAbort();
            lease?.succeeded();
            lease?.release();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (err) {
          detachAbort();
          if (isHardFailure(err)) {
            // The caller aborted us; the provider is not at fault and must not be marked down.
            lease?.succeeded();
            lease?.release();
            controller.error(err);
            return;
          }
          // Output is already downstream, so another link would splice two different answers into
          // one reply. A failure here ends the call instead of advancing the chain.
          lease?.failed(classifyProviderError(err));
          lease?.release();
          logger.warn(
            `[llm] stream failed after commit models=${modelId} reason=${errorReason(err)}`
          );
          controller.error(err);
        }
      },
      cancel(reason) {
        abandoned();
        return reader.cancel(reason);
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
