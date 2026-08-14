import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "ai";
import { LlmProviderError } from "./provider-error";

/** Minimal logger surface for fallback events (pino/console compatible). */
export interface FallbackLogger {
  warn(msg: string): void;
}

const noopLogger: FallbackLogger = { warn() {} };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Hard failures abort fallback; 429/5xx/timeouts/network/unknown try the next provider. */
export function isHardFailure(err: unknown): boolean {
  if (isAbortError(err)) return true;
  if (err instanceof LlmProviderError) return true;
  if (LoadAPIKeyError.isInstance(err)) return true;
  if (APICallError.isInstance(err)) return err.isRetryable === false;
  return false;
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
    private readonly logger: FallbackLogger = noopLogger
  ) {
    const primary = models[0];
    if (!primary) throw new Error("FallbackModel requires at least one model");
    this.modelId = models.map((m) => m.modelId).join("|");
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
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

  async doStream(options: LanguageModelV4CallOptions) {
    let lastError: unknown;
    for (const model of this.models) {
      let result: Awaited<ReturnType<LanguageModelV4["doStream"]>>;
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
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
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
