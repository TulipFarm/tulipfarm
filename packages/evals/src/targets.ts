import {
  AgentLoop,
  type AgentLoopBudgetPort,
  type AgentLoopEvent,
  type AgentLoopEventSink,
  type AgentLoopLimits,
  type ExposedTool,
  InMemoryLoopCheckpointStore,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelMessage,
  type ModelPort,
  type ToolDispatchPort,
  type ToolDispatchRequest,
  type ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { EvalCase, TargetOutput, ToolCallObservation } from "./types";

/**
 * A target is the thing under evaluation: it turns a case into a normalized `TargetOutput`. Every
 * production target runs a REAL model — scripted targets exist only in harness unit tests to
 * calibrate the scorers, never to assert agent quality.
 */
export interface EvalTarget {
  readonly name: string;
  execute(args: { readonly evalCase: EvalCase }): Promise<TargetOutput>;
}

const MODEL_ROLES = new Set<ModelMessage["role"]>(["system", "user", "assistant", "tool"]);

function toModelMessages(evalCase: EvalCase): ModelMessage[] {
  const { messages, prompt } = evalCase.input;
  if (messages !== undefined && messages.length > 0) {
    return messages.map((message) => ({
      role: (MODEL_ROLES as Set<string>).has(message.role)
        ? (message.role as ModelMessage["role"])
        : "user",
      content: message.content,
    }));
  }
  return [{ role: "user", content: prompt ?? "" }];
}

function mapModelResult(result: ModelInvocationResult): TargetOutput {
  const usage = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(result.usage.costUsd === undefined ? {} : { costUsd: result.usage.costUsd }),
  };
  if (result.output.kind === "tool_calls") {
    return {
      toolCalls: result.output.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
      usage,
    };
  }
  if (result.output.kind === "structured") {
    return { structured: result.output.value, usage };
  }
  return { text: result.output.text, usage };
}

export interface ModelTargetOptions {
  readonly model: ModelPort;
  readonly modelProfileId?: string;
  readonly tools?: readonly ExposedTool[];
}

/**
 * Single-step model target: one `invoke`, mapped to a `TargetOutput`. Enough to evaluate a direct
 * answer (quality/safety) or a one-shot tool selection (`toolCalls`), without the loop machinery.
 */
export function modelTarget(options: ModelTargetOptions): EvalTarget {
  return {
    name: "model",
    async execute({ evalCase }) {
      const request: ModelInvocationRequest = {
        requestId: `eval:${evalCase.caseId}`,
        modelProfileId: options.modelProfileId ?? "auto",
        messages: toModelMessages(evalCase),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
      };
      return mapModelResult(await options.model.invoke(request));
    },
  };
}

const NOOP_BUDGET: AgentLoopBudgetPort = {
  async consume() {
    return { outcome: "ok" };
  },
};

const DEFAULT_LOOP_LIMITS: AgentLoopLimits = {
  maxIterations: 8,
  maxToolCalls: 16,
  maxRepairAttempts: 2,
};

/** Records every dispatch so the `toolCalled` scorer can assert what the loop actually did. */
class CapturingDispatch implements ToolDispatchPort {
  readonly calls: ToolCallObservation[] = [];
  constructor(private readonly inner: ToolDispatchPort) {}
  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    this.calls.push({ name: request.name, arguments: request.arguments });
    return this.inner.dispatch(request);
  }
}

class CollectingEvents implements AgentLoopEventSink {
  readonly deltas: string[] = [];
  async append(event: AgentLoopEvent): Promise<void> {
    if (event.type === "text_delta" && event.text !== undefined) this.deltas.push(event.text);
  }
}

export interface AgentLoopTargetOptions {
  readonly model: ModelPort;
  /** The effect boundary. In tests a fake; in production the real tool broker adapter. */
  readonly dispatch: ToolDispatchPort;
  readonly tools: readonly ExposedTool[];
  readonly limits?: AgentLoopLimits;
  readonly businessId?: string;
  readonly modelProfileId?: string;
}

/**
 * Multi-step target: drives the real `AgentLoop` with an in-memory checkpoint store and a no-op
 * budget, capturing every dispatched tool call and the streamed/final text. This evaluates the
 * whole loop (tool selection, arguments, follow-through), not just a single model turn.
 */
export function agentLoopTarget(options: AgentLoopTargetOptions): EvalTarget {
  return {
    name: "agent-loop",
    async execute({ evalCase }) {
      const capturing = new CapturingDispatch(options.dispatch);
      const events = new CollectingEvents();
      const usage: { inputTokens: number; outputTokens: number } = {
        inputTokens: 0,
        outputTokens: 0,
      };
      const model: ModelPort = {
        async invoke(request) {
          const result = await options.model.invoke(request);
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
          return result;
        },
      };
      const loop = new AgentLoop({
        model,
        tools: capturing,
        checkpoints: new InMemoryLoopCheckpointStore(),
        events,
        budget: NOOP_BUDGET,
        isCancelled: async () => false,
      });
      const outcome = await loop.run({
        businessId: options.businessId ?? "eval",
        runId: `eval:${evalCase.caseId}`,
        stateId: "eval",
        modelProfileId: options.modelProfileId ?? "auto",
        contextDigest: "eval",
        guardrailDigest: "eval",
        messages: toModelMessages(evalCase),
        tools: options.tools,
        limits: options.limits ?? DEFAULT_LOOP_LIMITS,
      });

      const finalText =
        outcome.status === "completed" && typeof outcome.output === "string"
          ? outcome.output
          : events.deltas.join("");
      const structured =
        outcome.status === "completed" && typeof outcome.output !== "string"
          ? outcome.output
          : undefined;
      return {
        ...(finalText.length > 0 ? { text: finalText } : {}),
        ...(structured === undefined ? {} : { structured }),
        toolCalls: capturing.calls,
        usage,
      };
    },
  };
}
