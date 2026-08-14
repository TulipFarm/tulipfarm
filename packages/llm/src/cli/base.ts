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
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number };

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
   * The deadline aborts the turn, and an aborted `runTurn` ends its stream normally — so without
   * this the truncated turn is indistinguishable from a completed one, and the AgentLoop commits
   * a half-written answer to the durable transcript as final. A caller-driven abort is different
   * and stays silent: the caller already knows it cancelled.
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
