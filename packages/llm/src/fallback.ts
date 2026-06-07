import {
  APICallError,
  type LanguageModelV1,
  type LanguageModelV1CallOptions,
  type LanguageModelV1StreamPart,
  LoadAPIKeyError,
} from "ai";

type ObjectGenerationMode = "json" | "tool" | undefined;

/** Minimal logger surface for fallback events (pino/console compatible). */
export interface FallbackLogger {
  warn(msg: string): void;
}

const noopLogger: FallbackLogger = { warn() {} };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * A hard failure aborts the chain immediately — retrying another provider cannot
 * help. Covers request cancellation, missing/invalid credentials, and any
 * APICallError the SDK marks non-retryable (401/403 auth, 404 model-not-found,
 * 400 bad-request). Everything else (429/5xx/timeout/network/unknown) is
 * transient and falls back to the next provider.
 */
export function isHardFailure(err: unknown): boolean {
  if (isAbortError(err)) return true;
  if (LoadAPIKeyError.isInstance(err)) return true;
  if (APICallError.isInstance(err)) return err.isRetryable === false;
  return false;
}

function errorReason(err: unknown): string {
  if (APICallError.isInstance(err)) return `${err.statusCode ?? "?"} ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class FallbackModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "fallback";
  readonly modelId: string;
  readonly defaultObjectGenerationMode: ObjectGenerationMode;
  readonly supportsImageUrls?: boolean;
  readonly supportsStructuredOutputs?: boolean;

  constructor(
    private readonly models: LanguageModelV1[],
    private readonly logger: FallbackLogger = noopLogger
  ) {
    const primary = models[0];
    if (!primary) throw new Error("FallbackModel requires at least one model");
    this.modelId = models.map((m) => m.modelId).join("|");
    this.defaultObjectGenerationMode = primary.defaultObjectGenerationMode;
    this.supportsImageUrls = primary.supportsImageUrls;
    this.supportsStructuredOutputs = primary.supportsStructuredOutputs;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    let lastError: unknown;
    for (const model of this.models) {
      try {
        return await model.doGenerate(options);
      } catch (err) {
        if (isHardFailure(err)) throw err;
        lastError = err;
        this.logFallback(model, err);
      }
    }
    this.logExhausted(lastError);
    throw lastError;
  }

  async doStream(options: LanguageModelV1CallOptions) {
    let lastError: unknown;
    for (const model of this.models) {
      let result: Awaited<ReturnType<LanguageModelV1["doStream"]>>;
      try {
        result = await model.doStream(options);
      } catch (err) {
        if (isHardFailure(err)) throw err;
        lastError = err;
        this.logFallback(model, err);
        continue;
      }

      const reader = result.stream.getReader();
      let firstChunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        firstChunk = await reader.read();
      } catch (err) {
        reader.cancel().catch(() => {});
        if (isHardFailure(err)) throw err;
        lastError = err;
        this.logFallback(model, err);
        continue;
      }

      // First chunk received — stream is committed, reconstruct with remaining
      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          if (!firstChunk.done) controller.enqueue(firstChunk.value);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
        cancel() {
          return reader.cancel();
        },
      });

      return { ...result, stream };
    }
    this.logExhausted(lastError);
    throw lastError;
  }

  private logFallback(model: LanguageModelV1, err: unknown): void {
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
