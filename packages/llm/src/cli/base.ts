import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** CLI adapter events are translated to AI SDK stream parts only in `CliLanguageModel`. */
export type CliTurnEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  /**
   * The model the vendor actually ran, when it reports one.
   *
   * Both CLIs are addressed by an alias, so without this the id on the way out is only the id we
   * asked for. A caller comparing two runs cannot otherwise tell a changed harness from a vendor
   * that moved the alias underneath it.
   */
  | { type: "model-version"; modelId: string };

/** Default per-call wall clock before a CLI subprocess is aborted as hung. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Shared AI SDK translation base; subprocess lifecycle and tool extraction stay in subclasses. */
export abstract class CliLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  abstract readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  protected readonly timeoutMs: number;

  constructor(modelId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.modelId = modelId;
    this.timeoutMs = timeoutMs;
  }

  /** Runs one model call and must always end with a `usage` event. */
  protected abstract runTurn(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal
  ): AsyncGenerator<CliTurnEvent>;

  private withTimeout(options: LanguageModelV4CallOptions): {
    signal: AbortSignal;
    clear: () => void;
    abort: () => void;
    timedOut: () => boolean;
  } {
    const controller = new AbortController();
    const timeoutMs = this.timeoutMs;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort(new Error(`CLI provider turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const forward = () => controller.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener("abort", forward, { once: true });
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", forward);
      },
      abort: () => controller.abort(new Error("CLI provider stream cancelled")),
      timedOut: () => expired,
    };
  }

  /**
   * Deadline aborts must surface as timeout errors; caller-driven aborts stay silent.
   */
  private assertNotTimedOut(timedOut: boolean) {
    if (timedOut) throw new Error(`CLI provider turn timed out after ${this.timeoutMs}ms`);
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { signal, clear, timedOut } = this.withTimeout(options);
    try {
      const content: LanguageModelV4Content[] = [];
      let text = "";
      let usage: LanguageModelV4Usage = emptyUsage();
      let sawToolCall = false;
      let modelId: string | undefined;

      for await (const event of this.runTurn(options, signal)) {
        if (event.type === "text-delta") text += event.delta;
        else if (event.type === "model-version") modelId = event.modelId;
        else if (event.type === "tool-call") {
          sawToolCall = true;
          content.push({
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: JSON.stringify(event.input),
          });
        } else if (event.type === "usage") {
          usage = toUsage(event.inputTokens, event.outputTokens, event.cacheReadTokens);
        }
      }

      this.assertNotTimedOut(timedOut());

      if (text.trim()) content.unshift({ type: "text", text });

      return {
        content,
        finishReason: finishReasonFor(sawToolCall),
        usage,
        warnings: [],
        ...(modelId === undefined ? {} : { response: { modelId } }),
      };
    } finally {
      clear();
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const { signal, clear, abort, timedOut } = this.withTimeout(options);
    const runTurn = this.runTurn.bind(this);
    const timeoutMs = this.timeoutMs;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        let usage: LanguageModelV4Usage = emptyUsage();
        let sawToolCall = false;
        let textId: string | undefined;
        try {
          for await (const event of runTurn(options, signal)) {
            if (event.type === "text-delta") {
              if (textId === undefined) {
                textId = "text-0";
                controller.enqueue({ type: "text-start", id: textId });
              }
              controller.enqueue({ type: "text-delta", id: textId, delta: event.delta });
            } else if (event.type === "tool-call") {
              sawToolCall = true;
              controller.enqueue({
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: JSON.stringify(event.input),
              });
            } else if (event.type === "usage") {
              usage = toUsage(event.inputTokens, event.outputTokens, event.cacheReadTokens);
            } else if (event.type === "model-version") {
              controller.enqueue({ type: "response-metadata", modelId: event.modelId });
            }
          }
          if (timedOut()) throw new Error(`CLI provider turn timed out after ${timeoutMs}ms`);
          if (textId !== undefined) controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({ type: "finish", usage, finishReason: finishReasonFor(sawToolCall) });
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          clear();
        }
      },
      cancel() {
        // Abort first: the child process and its jail are only torn down by `runTurn`'s own
        // `finally`, which never runs while it sits awaiting the next server event. Clearing the
        // watchdog without aborting would strand both for good.
        abort();
        clear();
      },
    });

    return { stream };
  }
}

function emptyUsage(): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

/**
 * `inputTokens` is always the *total* input, cache reads included — each adapter normalises to that
 * before yielding, because the two CLIs disagree about whether their own input field is inclusive.
 */
function toUsage(
  inputTokens: number,
  outputTokens: number,
  cacheRead?: number
): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: cacheRead === undefined ? inputTokens : Math.max(0, inputTokens - cacheRead),
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function finishReasonFor(sawToolCall: boolean): LanguageModelV4FinishReason {
  return sawToolCall
    ? { unified: "tool-calls", raw: "tool_use" }
    : { unified: "stop", raw: "stop" };
}
