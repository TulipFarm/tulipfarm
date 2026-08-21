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
    private readonly providerKeys: readonly string[] = models.map((model) => model.provider)
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
        lease = await this.gate?.acquire(this.providerKey(index, model));
        const generated = await model.doGenerate(options);
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

  async doStream(options: LanguageModelV4CallOptions) {
    let lastError: unknown;
    for (const [index, model] of this.models.entries()) {
      let lease: FallbackCallLease | undefined;
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
      try {
        lease = await this.gate?.acquire(this.providerKey(index, model));
        result = await model.doStream(options);
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
      const chunks: LanguageModelV4StreamPart[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
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

      lease?.succeeded();
      lease?.release();
      this.commit(model);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });

      return { ...result, stream };
    }
    this.logExhausted(lastError);
    throw lastError;
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
    this.logger.warn(
      `[llm] all providers exhausted models=${this.modelId} reason=${errorReason(err)}`
    );
  }
}
