import { ajv, textContent } from "@tulipfarm/schema";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelUsage,
} from "../ports";
import { ModelInvocationError } from "../ports";
import { chargeModelUsage } from "./budget";
import type { AgentLoopCheckpoint } from "./checkpoint";
import type {
  AgentLoopDependencies,
  AgentLoopEvent,
  AgentLoopEventType,
  AgentLoopFailureReason,
  AgentLoopInput,
  AgentLoopOutcome,
  ExposedTool,
  ToolDispatchResult,
} from "./contract";
import {
  deepestErrorMessage,
  EventSinkFailure,
  isHandoffTool,
  isReportTool,
  REQUEST_INPUT_TOOL,
} from "./diagnostics";
import { extractSkillName, narrowToolsToSkill } from "./narrowing";
import {
  extractRereadFile,
  FILE_READ_TOOL,
  type RereadFile,
  rememberReread,
  resolveIterationAttachments,
} from "./reread";
import type { AgentLoopResumeState } from "./resume";
import type { NormalizedToolCall } from "./transcript";
import {
  assistantToolCallMessage,
  errorText,
  normalizeCalls,
  parseJson,
  toolMessage,
} from "./transcript";

/** Bounded Tool loop: broker-only effects, untrusted model output, durable budgets. */

const ITERATION_BUDGET_KEY = "iterations";

/**
 * How many times one Tool may answer with the same rejection before the loop stops treating it as
 * an argument the model can repair. Two, so the model still gets one deliberate correction at a
 * reason it has seen: a genuine schema complaint usually moves on the first retry.
 */
const REPEATED_REJECTION_LIMIT = 2;

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDependencies) {}

  async run(input: AgentLoopInput): Promise<AgentLoopOutcome> {
    const resumed = await this.deps.checkpoints.load(input.businessId, input.runId, input.stateId);
    const counters = {
      iterations: resumed?.iterations ?? 0,
      toolCalls: resumed?.toolCalls ?? 0,
      repairs: resumed?.repairs ?? 0,
    };

    const exposed = new Map(input.tools.map((tool) => [tool.name, tool]));
    const validate = input.outputSchema === undefined ? undefined : ajv.compile(input.outputSchema);
    // The recovered suffix is appended to, not merged with, the caller's messages: the caller
    // re-assembles the participant-visible history each attempt, and only what the loop itself
    // added — proposed Tool calls and their results — is missing from it.
    const recovered = resumed?.resume;
    const messages: ModelMessage[] = [...input.messages, ...(recovered?.messages ?? [])];
    let sequence = recovered?.sequence ?? 0;
    // The most recently *successfully* loaded Skill, per the `load_skill` dispatch — a switch
    // replaces it rather than unioning, since the model has moved on and a union only re-grows
    // the catalog this exists to shrink.
    let activeSkillName: string | undefined = recovered?.activeSkillName;
    // The approved-but-never-executed call this Turn parked on, replayed before the model runs
    // again so the user's one approval performs the work once, with no re-planning round trip.
    let replay = recovered?.pendingCall;
    // Files the Agent went back for mid-Turn. Held as names, not bytes: what the model is sent is
    // re-fetched every iteration, so authority is re-checked at assembly time rather than trusted
    // from the moment the Tool ran.
    let reread: readonly RereadFile[] = recovered?.rereadFiles ?? [];
    // A report cannot describe an effect that lands after it, so a reported Turn may not write.
    let reported = recovered?.reported ?? false;
    // How often each Tool has answered with the same rejection this attempt. Deliberately not
    // checkpointed: a resume replays the transcript, so the model can see the repetition itself,
    // and `repairs` — which is persisted — still bounds what a resumed Turn may spend.
    const rejectionCounts = new Map<string, number>();

    const toolsForIteration = (): readonly ExposedTool[] =>
      narrowToolsToSkill(input.tools, activeSkillName, input.skillToolScopes);

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

    const checkpoint = async (pendingCall?: AgentLoopResumeState["pendingCall"]): Promise<void> => {
      const next: AgentLoopCheckpoint = {
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        ...counters,
        resume: {
          messages: messages.slice(input.messages.length),
          ...(pendingCall === undefined ? {} : { pendingCall }),
          ...(activeSkillName === undefined ? {} : { activeSkillName }),
          ...(reported ? { reported } : {}),
          ...(reread.length === 0 ? {} : { rereadFiles: reread }),
          sequence,
          textIndex,
        },
      };
      await this.deps.checkpoints.save(next);
    };

    /** A settled loop keeps its counters and drops the transcript it no longer owes anyone. */
    const finish = async (
      outcome: AgentLoopOutcome,
      type: AgentLoopEventType
    ): Promise<AgentLoopOutcome> => {
      await this.deps.checkpoints.save({
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        ...counters,
      });
      await emit(type);
      return outcome;
    };

    let textIndex = recovered?.textIndex ?? 0;

    /**
     * Model text already shown to the participant. An asking Turn has no `completed` output to
     * persist, yet the reader has read this prose above the question; dropping it would leave a
     * refreshed transcript showing the question with nothing explaining it.
     */
    let streamedText = "";

    /** Both dispatch paths can reach the question, and both end the Turn the same way. */
    const askedForInput = (callId: string) =>
      finish({ status: "input_required", callId, text: streamedText, ...counters }, "completed");

    /** A refusal read off a call's identity: it never dispatches, and no repair path follows. */
    const barrier = async (call: NormalizedToolCall, reason: AgentLoopFailureReason) => {
      const { name: toolName, callId } = call;
      await emit("tool_call_rejected", { toolName, callId, outcome: reason });
      return finish({ status: "failed", reason, ...counters }, "failed");
    };

    /** Streams text deltas; missing `completed` is a model-adapter contract failure. */
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
        streamedText += chunk.text;
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

    /** Charges tokens and cost against the Run budget; shared by the success and failure paths. */
    const chargeUsage = (usage: ModelUsage): Promise<"ok" | "exhausted"> =>
      chargeModelUsage(this.deps.budget, usage);

    /**
     * Dispatches one model-proposed batch and records it in the transcript. Returns the
     * outcome that ends the loop, or `undefined` to keep iterating. `replayed` marks calls
     * recovered from an approval park: their proposal is already in the recovered transcript,
     * so it must not be written a second time.
     */
    const dispatchCalls = async (
      calls: readonly NormalizedToolCall[],
      replayed: boolean
    ): Promise<AgentLoopOutcome | undefined> => {
      // Recorded before dispatch so the transcript carries the model's own proposed call
      // alongside the result it provoked — without this, a validation error arrives as an
      // unattributed message and the model cannot tell it is feedback on its own last action.
      if (!replayed) messages.push(assistantToolCallMessage(calls));
      let approval: { approvalId: string; call: NormalizedToolCall } | undefined;

      // Applies one dispatched result: records the transcript entry, and reports back either
      // "keep going", the approval this Turn now waits on, or the failure reason that ends it.
      const applyDispatch = async (
        call: { callId: string; name: string; arguments: unknown },
        dispatched: ToolDispatchResult
      ): Promise<
        | { kind: "continue" }
        | { kind: "approval"; approvalId: string; call: NormalizedToolCall }
        | { kind: "input_required"; call: NormalizedToolCall }
        | { kind: "fail"; reason: AgentLoopFailureReason }
      > => {
        await emit("tool_call_dispatched", {
          toolName: call.name,
          callId: call.callId,
          outcome: dispatched.status,
        });

        if (dispatched.status === "awaiting_approval") {
          return { kind: "approval", approvalId: dispatched.approvalId, call };
        }

        // The barrier is the question, not the answer: once this Turn has asked the operator to
        // decide, nothing else in it may act on the model's own default. A call that reached
        // nobody ends the Turn rather than feeding the model a failure it will route around,
        // which is how an unanswered ask became a rubber stamp (#405).
        if (call.name === REQUEST_INPUT_TOOL) {
          if (dispatched.status !== "succeeded") {
            return { kind: "fail", reason: "input_request_failed" };
          }
          messages.push(toolMessage(call.callId, { output: dispatched.output }));
          return { kind: "input_required", call };
        }

        if (dispatched.status === "invalid_arguments") {
          const signature = `${call.name} ${dispatched.reason}`;
          const seen = (rejectionCounts.get(signature) ?? 0) + 1;
          rejectionCounts.set(signature, seen);
          // A rejection the model has now provoked past the limit is not tracking its arguments:
          // it changed them and the answer did not move. Repairing again can only reproduce it,
          // and spending the rest of the budget doing so is how a Tool that is broken — or simply
          // reporting an obstacle in the wrong shape — ends the Turn as `repair_budget_exhausted`
          // instead of letting the model route around it. Past the limit it is data the model must
          // reason about, like any other failure.
          if (seen > REPEATED_REJECTION_LIMIT) {
            this.deps.log?.warn(
              {
                event: "agent_loop.rejection_not_repairable",
                runId: input.runId,
                stateId: input.stateId,
                iteration: counters.iterations,
                callId: call.callId,
                toolName: call.name,
                occurrences: seen,
              },
              "tool rejection repeated unchanged; handing it to the model as a failure"
            );
            messages.push(toolMessage(call.callId, { error: "failed", detail: dispatched.reason }));
            return { kind: "continue" };
          }
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
          if (isReportTool(call.name)) reported = true;
          if (call.name === "load_skill") {
            const loaded = extractSkillName(call.arguments);
            if (loaded !== undefined) activeSkillName = loaded;
          }
          if (call.name === FILE_READ_TOOL) {
            const file = extractRereadFile(dispatched.output);
            if (file !== undefined) reread = rememberReread(reread, file);
          }
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
          // A hand-off is a barrier read off the call's identity, never off its result: routing
          // around the feedback is how a hand-off nobody performed ends up reported as done
          // (#419). Deliberately no repair path.
          if (isHandoffTool(call.name)) return barrier(call, "handoff_unavailable");
          // A Tool the caller never exposed is refused here; the broker never sees it.
          const outcome = "tool_not_available";
          messages.push(toolMessage(call.callId, { error: outcome }));
          await emit("tool_call_rejected", { toolName: call.name, callId: call.callId, outcome });
          index += 1;
          continue;
        }

        if (tool.mutating !== false) {
          // Nothing this Turn does next can correct a report the participant has already read, so
          // the effect that report does not describe must not land (#429).
          if (reported) return barrier(call, "effect_after_report");
          // A write dispatches alone: the next Tool call must never race the effect it causes.
          // The ceiling is checked before the dispatch, never after: `maxToolCalls` is backed by
          // a durable checkpoint, so a call counted after its effect would let a resume replay
          // past the limit.
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
            ...(activeSkillName === undefined ? {} : { activeSkillName }),
          });
          counters.toolCalls += 1;
          const outcome = await applyDispatch(call, dispatched);
          if (outcome.kind === "fail") {
            return finish({ status: "failed", reason: outcome.reason, ...counters }, "failed");
          }
          if (outcome.kind === "approval") {
            approval = { approvalId: outcome.approvalId, call: outcome.call };
            break;
          }
          if (outcome.kind === "input_required") return askedForInput(outcome.call.callId);
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
              ...(activeSkillName === undefined ? {} : { activeSkillName }),
            })
          )
        );
        counters.toolCalls += runBatch.length;
        index += runBatch.length;

        // Every call in the batch has already run: its effect landed and its Tool-call budget
        // is already spent. So every result is applied — stopping at the first decisive one
        // would drop the rest's transcript entries, dispatch events and repair accounting for
        // work the Run was charged for. Only the *decision* stops: the first decisive outcome
        // in call order wins, matching what a sequential batch would have produced.
        let decision:
          | { kind: "approval"; approvalId: string; call: NormalizedToolCall }
          | { kind: "input_required"; call: NormalizedToolCall }
          | { kind: "fail"; reason: AgentLoopFailureReason }
          | undefined;
        for (let i = 0; i < runBatch.length; i += 1) {
          const batchCall = runBatch[i];
          const batchResult = dispatched[i];
          if (batchCall === undefined || batchResult === undefined) continue;
          const outcome = await applyDispatch(batchCall, batchResult);
          if (outcome.kind === "continue") continue;
          if (decision !== undefined) {
            // A Turn parks on one approval and fails for one reason, so a second decisive
            // outcome cannot be acted on. A superseded approval stays pending at the broker
            // with nothing waiting on it; its `tool_call_dispatched` event above is the
            // record, and this names it for an operator who has to clear it.
            this.deps.log?.warn(
              {
                event: "agent_loop.batch_outcome_superseded",
                runId: input.runId,
                stateId: input.stateId,
                iteration: counters.iterations,
                callId: batchCall.callId,
                toolName: batchCall.name,
                superseded: outcome.kind,
                ...(outcome.kind === "approval" ? { approvalId: outcome.approvalId } : {}),
                actedOn: decision.kind,
              },
              "batch outcome superseded by an earlier decisive call"
            );
            continue;
          }
          decision = outcome;
        }
        if (decision?.kind === "fail") {
          return finish({ status: "failed", reason: decision.reason, ...counters }, "failed");
        }
        if (decision?.kind === "input_required") return askedForInput(decision.call.callId);
        if (decision !== undefined) {
          approval = { approvalId: decision.approvalId, call: decision.call };
          break;
        }
        // A batch clipped by budget leaves its remainder at `index`; the next pass re-enters this
        // branch, forms a fresh (now over-budget) peek, and fails via `available <= 0` above
        // rather than ever dispatching past the limit.
      }

      if (approval !== undefined) {
        // A parked call has not run: the dispatcher reports `awaiting_approval` strictly before
        // it executes the Tool, so the budget it took on dispatch is given back and spent only
        // by the replay that actually performs the work. Counters and the transcript are made
        // durable together, so the resumed Turn is charged for exactly what it can still see.
        counters.toolCalls -= 1;
        await checkpoint(approval.call);
        await emit("awaiting_approval");
        // Saved again for one reason only: to carry the sequence that event just consumed, so the
        // resumed attempt numbers its events past this one instead of colliding with it. The save
        // above stays first, because a crash between the two must still find durable counters.
        await checkpoint(approval.call);
        return {
          status: "awaiting_approval",
          approvalId: approval.approvalId,
          callId: approval.call.callId,
          ...counters,
        };
      }
      // Checkpointed after every dispatched batch, so a Turn that dies here resumes with the
      // Tool results it already paid for rather than re-running them.
      await checkpoint();
      return undefined;
    };

    for (;;) {
      // Order is load-bearing for the whole iteration: cancellation is checked before any spend,
      // the iteration ceiling before the budget is charged for an iteration that cannot run, and
      // the budget is charged before the model is called — a charge after the call would let a
      // Run spend past an exhausted budget. `counters.iterations` only advances once all three
      // have passed, so a resumed checkpoint never double-counts a refused iteration.
      if (await this.deps.isCancelled()) {
        return finish({ status: "cancelled", ...counters }, "cancelled");
      }

      // A replayed approval is the tail of an iteration that already ran and was already charged;
      // it re-enters dispatch without a model call, so it takes no iteration, no budget and no
      // second assistant message. Everything else asks the model as usual.
      const replayed = replay;
      if (replayed !== undefined) {
        replay = undefined;
        const outcome = await dispatchCalls([replayed], true);
        if (outcome !== undefined) return outcome;
        continue;
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

      const attachments = await resolveIterationAttachments(
        input.attachments ?? [],
        reread,
        this.deps.attachments,
        input.runId
      );
      const request: ModelInvocationRequest = {
        requestId: `${input.runId}:${input.stateId}:${counters.iterations}`,
        modelProfileId: input.modelProfileId,
        messages,
        tools: toolsForIteration(),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(input.modelPolicy === undefined ? {} : { policy: input.modelPolicy }),
        ...(input.principal === undefined ? {} : { principal: input.principal }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
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
        const reason =
          error instanceof ModelInvocationError ? error.reason : ("model_error" as const);
        const diagnostic =
          error instanceof ModelInvocationError && error.cause !== undefined ? error.cause : error;
        this.deps.log?.warn(
          {
            event: "agent_loop.model_error",
            requestId: request.requestId,
            iteration: counters.iterations,
            reason,
            error: deepestErrorMessage(diagnostic),
          },
          "model call failed"
        );
        // A failed call still spent whatever the provider consumed before it stopped. Charging it
        // before finishing is what stops a Run that fails every iteration from spending without
        // limit against a budget it never touches.
        if (error instanceof ModelInvocationError && error.usage !== undefined) {
          await chargeUsage(error.usage);
        }
        return finish(
          {
            status: "failed",
            reason,
            ...(error instanceof ModelInvocationError
              ? {
                  modelFailure: {
                    requestId: request.requestId,
                    ...(error.modelId === undefined ? {} : { modelId: error.modelId }),
                  },
                }
              : {}),
            ...counters,
          },
          "failed"
        );
      }

      const spend = await chargeUsage(result.usage);
      if (spend === "exhausted") {
        return finish({ status: "failed", reason: "budget_exhausted", ...counters }, "failed");
      }

      // An unpriceable call is not a free one. The port refuses one up front when the profile
      // declared a cost ceiling, so reaching here with `unpriced` means no ceiling was declared
      // and there is nothing to enforce — charging a guessed amount would invent a limit the
      // operator never set.

      if (result.output.kind === "tool_calls") {
        const outcome = await dispatchCalls(
          normalizeCalls(result.output.calls, counters.iterations),
          false
        );
        if (outcome !== undefined) return outcome;
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
          content: textContent(
            JSON.stringify({
              error: "structured_output_invalid",
              detail: errorText(validate),
            })
          ),
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
          content: textContent(
            JSON.stringify({
              error: "empty_output",
              detail: "Your last response had no content. Provide a final answer for the user.",
            })
          ),
        });
        await checkpoint();
        continue;
      }

      const output = result.output.kind === "structured" ? result.output.value : result.output.text;
      return finish({ status: "completed", output, ...counters }, "completed");
    }
  }
}
