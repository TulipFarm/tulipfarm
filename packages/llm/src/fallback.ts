import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from "ai";

type ObjectGenerationMode = "json" | "tool" | undefined;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export class FallbackModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "fallback";
  readonly modelId: string;
  readonly defaultObjectGenerationMode: ObjectGenerationMode;
  readonly supportsImageUrls?: boolean;
  readonly supportsStructuredOutputs?: boolean;

  constructor(private readonly models: LanguageModelV1[]) {
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
        if (isAbortError(err)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async doStream(options: LanguageModelV1CallOptions) {
    let lastError: unknown;
    for (const model of this.models) {
      let result: Awaited<ReturnType<LanguageModelV1["doStream"]>>;
      try {
        result = await model.doStream(options);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = err;
        continue;
      }

      const reader = result.stream.getReader();
      let firstChunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        firstChunk = await reader.read();
      } catch (err) {
        reader.cancel().catch(() => {});
        if (isAbortError(err)) throw err;
        lastError = err;
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
    throw lastError;
  }
}
