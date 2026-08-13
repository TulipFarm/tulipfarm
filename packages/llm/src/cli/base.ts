import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/**
 * Simplified event vocabulary a CLI adapter (`claude-code.ts`, later `codex.ts`) emits from its
 * `runTurn` generator. `CliLanguageModel` translates these into the AI SDK's `LanguageModelV4`
 * shapes for both `doGenerate` (aggregated) and `doStream` (incremental) — the adapter itself
 * never touches AI SDK stream-part framing.
 */
export type CliTurnEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number };

/** Default per-call wall clock before a CLI subprocess is aborted as hung. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Shared `LanguageModelV4` base for coding-agent CLIs run as a subscription-backed model provider.
 * Owns the AI SDK translation only; subprocess lifecycle, credential jailing, transcript
 * rendering, and the "capture → abort → replay" tool-call extraction live in each subclass.
 */
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

  /** Run one model call end-to-end, yielding events as they happen. Must always end with a `usage` event. */
  protected abstract runTurn(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal
  ): AsyncGenerator<CliTurnEvent>;

  private withTimeout(options: LanguageModelV4CallOptions): {
    signal: AbortSignal;
    clear: () => void;
  } {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("CLI provider turn timed out")),
      this.timeoutMs
    );
    const forward = () => controller.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener("abort", forward, { once: true });
    return {
      signal: controller.signal,
      clear: () => {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", forward);
      },
    };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { signal, clear } = this.withTimeout(options);
    try {
      const content: LanguageModelV4Content[] = [];
      let text = "";
      let usage: LanguageModelV4Usage = emptyUsage();
      let sawToolCall = false;

      for await (const event of this.runTurn(options, signal)) {
        if (event.type === "text-delta") text += event.delta;
        else if (event.type === "tool-call") {
          sawToolCall = true;
          content.push({
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: JSON.stringify(event.input),
          });
        } else if (event.type === "usage") {
          usage = toUsage(event.inputTokens, event.outputTokens);
        }
      }

      if (text.trim()) content.unshift({ type: "text", text });

      return {
        content,
        finishReason: finishReasonFor(sawToolCall),
        usage,
        warnings: [],
      };
    } finally {
      clear();
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const { signal, clear } = this.withTimeout(options);
    const runTurn = this.runTurn.bind(this);

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
              usage = toUsage(event.inputTokens, event.outputTokens);
            }
          }
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

function toUsage(inputTokens: number, outputTokens: number): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
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
