import { ajv } from "@tulipfarm/schema";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelPort,
} from "../ports";
import type { AgentLoopCheckpoint, LoopCheckpointStore } from "./checkpoint";

/**
 * Bounded, durable Agent Tool loop (SPEC §10).
 *
 * Invariants this file exists to hold:
 * - The Tool broker is the only effect path. The loop never executes a Tool, and a Tool the caller
 *   did not expose is refused here rather than handed to the broker.
 * - Model output is untrusted data. Denials, malformed calls, and schema-invalid structured output
 *   come back as transcript content, never as control flow the model can widen.
 * - Every loop, Tool-call, repair, and budget limit is checked against durable counters, so a
 *   resumed State cannot buy itself a fresh budget by crashing.
 */

export interface AgentLoopLimits {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxRepairAttempts: number;
}

export interface ExposedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Whether this Tool writes. Only `false` unlocks concurrent dispatch (TOOL-V1-008's "concurrent
   * reads, sequential writes" rule, applied here too) — absent or `true` keeps a Tool sequential,
   * so a caller that has not threaded this field through yet keeps today's safe behavior rather
   * than being silently parallelized.
   */
  readonly mutating?: boolean;
}

export interface AgentLoopInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly modelProfileId: string;
  /** Digest of the Context manifest the messages were assembled from. */
  readonly contextDigest: string;
  readonly guardrailDigest: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ExposedTool[];
  readonly limits: AgentLoopLimits;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface ToolDispatchRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ToolDispatchResult =
  | { readonly status: "succeeded"; readonly callId: string; readonly output: unknown }
  | { readonly status: "denied"; readonly callId: string; readonly reason: string }
  | { readonly status: "invalid_arguments"; readonly callId: string; readonly reason: string }
  | { readonly status: "failed"; readonly callId: string; readonly reason: string }
  | {
      readonly status: "awaiting_approval";
      readonly callId: string;
      readonly approvalId: string;
    };

/** The broker-backed effect boundary. Authorization, validation, and effects all live behind it. */
export interface ToolDispatchPort {
  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult>;
}

export type AgentLoopEventType =
  | "iteration_started"
  | "text_delta"
  | "tool_call_dispatched"
  | "tool_call_rejected"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Persisted loop event. Consumers stream by `sequence`, so a reconnecting client resumes from its
 * cursor instead of replaying the model.
 *
 * The only content this carries is model text (`text_delta`) — the one thing that exists nowhere
 * else, since the loop consumes the model stream itself. Tool arguments and Tool output are
 * deliberately absent: the caller's `ToolDispatchPort` already holds both, so it emits whatever
 * call/result/Surface record a channel should see, and decides there what is safe to reproduce.
 * Keeping that decision at the dispatch boundary is why a secret passed as a Tool argument cannot
 * reach a reader through this stream.
 */
export interface AgentLoopEvent {
  readonly sequence: number;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly type: AgentLoopEventType;
  readonly iteration: number;
  readonly toolName?: string;
  readonly callId?: string;
  readonly outcome?: string;
  /** Model text released this chunk. Present only on `text_delta`. */
  readonly text?: string;
  /** 1-based ordinal of this delta within the State, so a reader can order and de-duplicate. */
  readonly textIndex?: number;
  readonly occurredAt: string;
}

export interface AgentLoopEventSink {
  append(event: AgentLoopEvent): Promise<void>;
}

/** Structural view of the Run kernel budget manager: charge before use, fail closed. */
export interface AgentLoopBudgetPort {
  consume(input: { key: string; amount: number }): Promise<{ outcome: string }>;
}

export type AgentLoopFailureReason =
  | "iteration_limit"
  | "tool_call_limit"
  | "repair_budget_exhausted"
  | "budget_exhausted"
  | "model_error"
  | "empty_model_output";

export type AgentLoopOutcome =
  | {
      readonly status: "completed";
      readonly output: unknown;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "failed";
      readonly reason: AgentLoopFailureReason;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "awaiting_approval";
      readonly approvalId: string;
      readonly callId: string;
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    }
  | {
      readonly status: "cancelled";
      readonly iterations: number;
      readonly toolCalls: number;
      readonly repairs: number;
    };

export interface AgentLoopDependencies {
  readonly model: ModelPort;
  readonly tools: ToolDispatchPort;
  readonly checkpoints: LoopCheckpointStore;
  readonly events: AgentLoopEventSink;
  readonly budget: AgentLoopBudgetPort;
  isCancelled(): Promise<boolean>;
  /** Diagnostic only — a blank final completion is otherwise invisible in server logs. */
  readonly log?: { warn(obj: unknown, msg?: string): void };
  now?(): Date;
}

const ITERATION_BUDGET_KEY = "agent_loop_iterations";
const TOKEN_BUDGET_KEY = "agent_loop_tokens";

/**
 * Marks a failure that came from the event sink rather than the model, so the model's own error
 * handling cannot swallow it. Never escapes this module: the original error is rethrown in its
 * place, leaving the caller the same failure it would have seen from any other sink write.
 */
class EventSinkFailure extends Error {
  constructor(readonly cause: unknown) {
    super("event sink failed");
  }
}

type CompiledValidator = ReturnType<typeof ajv.compile>;

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDependencies) {}

  async run(input: AgentLoopInput): Promise<AgentLoopOutcome> {
    const resumed = await this.deps.checkpoints.load(input.runId, input.stateId);
    const counters = {
      iterations: resumed?.iterations ?? 0,
      toolCalls: resumed?.toolCalls ?? 0,
      repairs: resumed?.repairs ?? 0,
    };

    const exposed = new Map(input.tools.map((tool) => [tool.name, tool]));
    const validate = input.outputSchema === undefined ? undefined : ajv.compile(input.outputSchema);
    const messages: ModelMessage[] = [...input.messages];
    let sequence = 0;

    const emit = async (
      type: AgentLoopEventType,
      extra: Partial<
        Pick<AgentLoopEvent, "toolName" | "callId" | "outcome" | "text" | "textIndex">
      > = {}
    ): Promise<void> => {
      sequence += 1;
      await this.deps.events.append({
        sequence,
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        type,
        iteration: counters.iterations,
        occurredAt: (this.deps.now?.() ?? new Date()).toISOString(),
        ...extra,
      });
    };

    const checkpoint = async (): Promise<void> => {
      const next: AgentLoopCheckpoint = {
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        ...counters,
      };
      await this.deps.checkpoints.save(next);
    };

    const finish = async (
      outcome: AgentLoopOutcome,
      type: AgentLoopEventType
    ): Promise<AgentLoopOutcome> => {
      await checkpoint();
      await emit(type);
      return outcome;
    };

    let textIndex = 0;

    /**
     * One model call, releasing text as it arrives when the adapter can stream.
     *
     * Deltas are emitted during the call rather than after it returns, which is what lets a
     * participant on any channel watch the answer form. Both paths yield the same
     * `ModelInvocationResult`, so nothing below this line forks on which one ran. A stream that
     * ends without a `completed` chunk is a broken adapter contract, and is failed as a model
     * error rather than silently treated as an empty answer.
     */
    const callModel = async (request: ModelInvocationRequest): Promise<ModelInvocationResult> => {
      const stream = this.deps.model.stream?.(request);
      if (stream === undefined) return this.deps.model.invoke(request);

      let completed: ModelInvocationResult | undefined;
      for await (const chunk of stream) {
        if (chunk.kind === "completed") {
          completed = chunk.result;
          continue;
        }
        if (chunk.text.length === 0) continue;
        textIndex += 1;
        try {
          await emit("text_delta", { text: chunk.text, textIndex });
        } catch (error) {
          // Losing a durable write is not the model failing; see the rethrow below.
          throw new EventSinkFailure(error);
        }
      }
      if (completed === undefined) throw new Error("model stream ended without a result");
      return completed;
    };

    for (;;) {
      if (await this.deps.isCancelled()) {
        return finish({ status: "cancelled", ...counters }, "cancelled");
      }

      if (counters.iterations + 1 > input.limits.maxIterations) {
        return finish({ status: "failed", reason: "iteration_limit", ...counters }, "failed");
      }

      const iterationBudget = await this.deps.budget.consume({
        key: ITERATION_BUDGET_KEY,
        amount: 1,
      });
      if (iterationBudget.outcome === "exhausted") {
        return finish({ status: "failed", reason: "budget_exhausted", ...counters }, "failed");
      }

      counters.iterations += 1;
      await emit("iteration_started");

      const request: ModelInvocationRequest = {
        requestId: `${input.runId}:${input.stateId}:${counters.iterations}`,
        modelProfileId: input.modelProfileId,
        messages,
        tools: input.tools,
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      };

      let result: ModelInvocationResult;
      try {
        result = await callModel(request);
      } catch (error) {
        // A model that errors is an outcome the loop owns. A sink that cannot record what already
        // happened is not: the caller must reconcile it, so it escapes rather than being recorded
        // as a model failure through the very sink that just failed.
        if (error instanceof EventSinkFailure) throw error.cause;
        return finish({ status: "failed", reason: "model_error", ...counters }, "failed");
      }

      const tokenBudget = await this.deps.budget.consume({
        key: TOKEN_BUDGET_KEY,
        amount: result.usage.inputTokens + result.usage.outputTokens,
      });
      if (tokenBudget.outcome === "exhausted") {
        return finish({ status: "failed", reason: "budget_exhausted", ...counters }, "failed");
      }

      if (result.output.kind === "tool_calls") {
        const calls = normalizeCalls(result.output.calls, counters.iterations);
        // Recorded before dispatch so the transcript carries the model's own proposed call
        // alongside the result it provoked — without this, a validation error arrives as an
        // unattributed message and the model cannot tell it is feedback on its own last action.
        messages.push(assistantToolCallMessage(calls));
        let approval: { approvalId: string; callId: string } | undefined;

        // Applies one dispatched result: records the transcript entry, and reports back either
        // "keep going", the approval this Turn now waits on, or the failure reason that ends it.
        const applyDispatch = async (
          call: { callId: string; name: string; arguments: unknown },
          dispatched: ToolDispatchResult
        ): Promise<
          | { kind: "continue" }
          | { kind: "approval"; approvalId: string; callId: string }
          | { kind: "fail"; reason: AgentLoopFailureReason }
        > => {
          await emit("tool_call_dispatched", {
            toolName: call.name,
            callId: call.callId,
            outcome: dispatched.status,
          });

          if (dispatched.status === "awaiting_approval") {
            return { kind: "approval", approvalId: dispatched.approvalId, callId: call.callId };
          }

          if (dispatched.status === "invalid_arguments") {
            counters.repairs += 1;
            if (counters.repairs > input.limits.maxRepairAttempts) {
              return { kind: "fail", reason: "repair_budget_exhausted" };
            }
            messages.push(
              toolMessage(call.callId, { error: "invalid_arguments", detail: dispatched.reason })
            );
            return { kind: "continue" };
          }

          if (dispatched.status === "succeeded") {
            messages.push(toolMessage(call.callId, { output: dispatched.output }));
            return { kind: "continue" };
          }

          // Denied and failed calls are data the model must reason about, not a retry signal.
          messages.push(
            toolMessage(call.callId, { error: dispatched.status, detail: dispatched.reason })
          );
          return { kind: "continue" };
        };

        let index = 0;
        while (index < calls.length) {
          const call = calls[index];
          const tool = exposed.get(call.name);
          if (tool === undefined) {
            // A Tool the caller never exposed is refused here; the broker never sees it.
            messages.push(toolMessage(call.callId, { error: "tool_not_available" }));
            await emit("tool_call_rejected", {
              toolName: call.name,
              callId: call.callId,
              outcome: "tool_not_available",
            });
            index += 1;
            continue;
          }

          if (tool.mutating !== false) {
            // A write dispatches alone: the next Tool call must never race the effect it causes.
            if (counters.toolCalls + 1 > input.limits.maxToolCalls) {
              return finish({ status: "failed", reason: "tool_call_limit", ...counters }, "failed");
            }
            const dispatched = await this.deps.tools.dispatch({
              businessId: input.businessId,
              runId: input.runId,
              stateId: input.stateId,
              callId: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            counters.toolCalls += 1;
            const outcome = await applyDispatch(call, dispatched);
            if (outcome.kind === "fail") {
              return finish({ status: "failed", reason: outcome.reason, ...counters }, "failed");
            }
            if (outcome.kind === "approval") {
              approval = { approvalId: outcome.approvalId, callId: outcome.callId };
              break;
            }
            index += 1;
            continue;
          }

          // A run of consecutive, exposed, non-mutating calls dispatches together — reads share no
          // effect to race (TOOL-V1-008's "concurrent reads, sequential writes" rule, applied here
          // too). Peeking with a separate cursor, rather than advancing `index` as the run is
          // found, is what lets a batch longer than the remaining budget still stop at the exact
          // call that would exceed it: only the calls actually dispatched advance `index`.
          let peek = index;
          const batch: { callId: string; name: string; arguments: unknown }[] = [];
          while (peek < calls.length) {
            const next = calls[peek];
            const nextTool = exposed.get(next.name);
            if (nextTool === undefined || nextTool.mutating !== false) break;
            batch.push(next);
            peek += 1;
          }

          const available = input.limits.maxToolCalls - counters.toolCalls;
          if (available <= 0) {
            return finish({ status: "failed", reason: "tool_call_limit", ...counters }, "failed");
          }
          const runBatch = batch.slice(0, available);
          const dispatched = await Promise.all(
            runBatch.map((batched) =>
              this.deps.tools.dispatch({
                businessId: input.businessId,
                runId: input.runId,
                stateId: input.stateId,
                callId: batched.callId,
                name: batched.name,
                arguments: batched.arguments,
              })
            )
          );
          counters.toolCalls += runBatch.length;
          index += runBatch.length;

          let failure: AgentLoopFailureReason | undefined;
          for (
            let i = 0;
            i < runBatch.length && failure === undefined && approval === undefined;
            i += 1
          ) {
            const batchCall = runBatch[i];
            const batchResult = dispatched[i];
            if (batchCall === undefined || batchResult === undefined) continue;
            const outcome = await applyDispatch(batchCall, batchResult);
            if (outcome.kind === "fail") failure = outcome.reason;
            else if (outcome.kind === "approval") {
              approval = { approvalId: outcome.approvalId, callId: outcome.callId };
            }
          }
          if (failure !== undefined) {
            return finish({ status: "failed", reason: failure, ...counters }, "failed");
          }
          if (approval !== undefined) break;
          // A batch clipped by budget leaves its remainder at `index`; the next pass re-enters this
          // branch, forms a fresh (now over-budget) peek, and fails via `available <= 0` above
          // rather than ever dispatching past the limit.
        }

        await checkpoint();

        if (approval !== undefined) {
          return finish(
            { status: "awaiting_approval", ...approval, ...counters },
            "awaiting_approval"
          );
        }
        continue;
      }

      if (validate !== undefined) {
        const value =
          result.output.kind === "structured" ? result.output.value : parseJson(result.output.text);
        if (validate(value)) {
          return finish({ status: "completed", output: value, ...counters }, "completed");
        }

        counters.repairs += 1;
        if (counters.repairs > input.limits.maxRepairAttempts) {
          return finish(
            { status: "failed", reason: "repair_budget_exhausted", ...counters },
            "failed"
          );
        }
        messages.push({
          role: "user",
          content: JSON.stringify({
            error: "structured_output_invalid",
            detail: errorText(validate),
          }),
        });
        await checkpoint();
        continue;
      }

      if (result.output.kind === "text" && result.output.text.length === 0) {
        // A blank final completion with no tool call and no schema violation to explain it — the
        // provider gave up silently. Nudge for a real answer within the same repair budget a
        // schema-invalid completion uses, rather than terminal-failing the turn on the first blank.
        this.deps.log?.warn(
          {
            event: "agent_loop.empty_completion",
            requestId: request.requestId,
            iteration: counters.iterations,
            repairs: counters.repairs,
            usage: result.usage,
            providerRequestId: result.providerRequestId,
          },
          "model returned an empty final completion"
        );
        counters.repairs += 1;
        if (counters.repairs > input.limits.maxRepairAttempts) {
          return finish({ status: "failed", reason: "empty_model_output", ...counters }, "failed");
        }
        messages.push({
          role: "user",
          content: JSON.stringify({
            error: "empty_output",
            detail: "Your last response had no content. Provide a final answer for the user.",
          }),
        });
        await checkpoint();
        continue;
      }

      const output = result.output.kind === "structured" ? result.output.value : result.output.text;
      return finish({ status: "completed", output, ...counters }, "completed");
    }
  }
}

function normalizeCalls(
  calls: readonly { readonly callId: string; readonly name: string; readonly arguments: unknown }[],
  iteration: number
): readonly { callId: string; name: string; arguments: unknown }[] {
  // Providers sometimes omit or repeat call ids; correlation must stay unambiguous regardless.
  const seen = new Set<string>();
  return calls.map((call, index) => {
    const candidate = call.callId.trim();
    const callId =
      candidate === "" || seen.has(candidate) ? `call-${iteration}-${index + 1}` : candidate;
    seen.add(callId);
    return { callId, name: call.name, arguments: call.arguments };
  });
}

function toolMessage(callId: string, payload: Record<string, unknown>): ModelMessage {
  return { role: "tool", content: JSON.stringify({ callId, ...payload }) };
}

function assistantToolCallMessage(
  calls: readonly { readonly callId: string; readonly name: string; readonly arguments: unknown }[]
): ModelMessage {
  return {
    role: "assistant",
    content: JSON.stringify({
      toolCalls: calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })),
    }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(validate: CompiledValidator): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
