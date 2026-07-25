import { ajv } from "@tulipfarm/schema";
import type { ModelInvocationRequest, ModelMessage, ModelPort } from "../ports";
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
  | "tool_call_dispatched"
  | "tool_call_rejected"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Persisted, content-free loop event. Consumers stream by `sequence`, so a reconnecting client
 * resumes from its cursor instead of replaying the model.
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
  | "model_error";

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
  now?(): Date;
}

const ITERATION_BUDGET_KEY = "agent_loop_iterations";
const TOKEN_BUDGET_KEY = "agent_loop_tokens";

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
      extra: Partial<Pick<AgentLoopEvent, "toolName" | "callId" | "outcome">> = {}
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

      let result: Awaited<ReturnType<ModelPort["invoke"]>>;
      try {
        result = await this.deps.model.invoke(request);
      } catch {
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
        let approval: { approvalId: string; callId: string } | undefined;

        for (const call of calls) {
          const tool = exposed.get(call.name);
          if (tool === undefined) {
            // A Tool the caller never exposed is refused here; the broker never sees it.
            messages.push(toolMessage(call.callId, { error: "tool_not_available" }));
            await emit("tool_call_rejected", {
              toolName: call.name,
              callId: call.callId,
              outcome: "tool_not_available",
            });
            continue;
          }

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
          await emit("tool_call_dispatched", {
            toolName: call.name,
            callId: call.callId,
            outcome: dispatched.status,
          });

          if (dispatched.status === "awaiting_approval") {
            approval = { approvalId: dispatched.approvalId, callId: call.callId };
            break;
          }

          if (dispatched.status === "invalid_arguments") {
            counters.repairs += 1;
            if (counters.repairs > input.limits.maxRepairAttempts) {
              return finish(
                { status: "failed", reason: "repair_budget_exhausted", ...counters },
                "failed"
              );
            }
            messages.push(
              toolMessage(call.callId, { error: "invalid_arguments", detail: dispatched.reason })
            );
            continue;
          }

          if (dispatched.status === "succeeded") {
            messages.push(toolMessage(call.callId, { output: dispatched.output }));
            continue;
          }

          // Denied and failed calls are data the model must reason about, not a retry signal.
          messages.push(
            toolMessage(call.callId, { error: dispatched.status, detail: dispatched.reason })
          );
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
