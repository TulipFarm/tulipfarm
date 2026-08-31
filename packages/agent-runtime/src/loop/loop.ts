import { ajv, textContent } from "@tulipfarm/schema";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelUsage,
} from "../ports";
import { ModelInvocationError } from "../ports";
import { chargeModelUsage } from "./budget";
import { type CancelWatch, TurnCancelled, watchForCancel } from "./cancel";
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
import { isRetryableFailure } from "./contract";
import {
  deepestErrorMessage,
  EventSinkFailure,
  isHandoffTool,
  isReportTool,
  REQUEST_INPUT_TOOL,
} from "./diagnostics";
import { askFor, distilledPayload, latestAsk } from "./distill";
import { extractSkillName, narrowToolsToSkill, SKILL_TOOL } from "./narrowing";
import { capToolResult, MAX_TOOL_RESULT_CHARS } from "./oversize";
import {
  callSignature,
  elideRepeatedSkillText,
  repeatedCall,
  shortCircuitedRepeat,
} from "./repeat";
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
    // Resolved before the loop appends anything. `messages` grows to hold this loop's own repair
    // prompts, which carry the `user` role and would otherwise become the summariser's ask.
    const participantAsk = latestAsk(input.messages);
    let sequence = recovered?.sequence ?? 0;
    // The most recently *successfully* loaded Skill, per the `skill` dispatch — a switch
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
    // How often each Tool has already answered this exact question this attempt. Not checkpointed,
    // for the same reason: a resume replays the transcript, so the repetition stays visible there.
    const repeatCounts = new Map<string, number>();

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

    const resumeState = (
      pendingCall?: AgentLoopResumeState["pendingCall"]
    ): AgentLoopResumeState => ({
      messages: messages.slice(input.messages.length),
      ...(pendingCall === undefined ? {} : { pendingCall }),
      ...(activeSkillName === undefined ? {} : { activeSkillName }),
      ...(reported ? { reported } : {}),
      ...(reread.length === 0 ? {} : { rereadFiles: reread }),
      sequence,
      textIndex,
    });

    const checkpoint = async (pendingCall?: AgentLoopResumeState["pendingCall"]): Promise<void> => {
      const next: AgentLoopCheckpoint = {
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        ...counters,
        resume: resumeState(pendingCall),
      };
      await this.deps.checkpoints.save(next);
    };

    /**
     * A settled loop keeps its counters and drops the transcript it no longer owes anyone.
     *
     * A transient model failure is the exception: the loop is settled, but the Tool results it
     * already paid for are exactly what a retry would otherwise buy again. Holding the transcript
     * is what lets a retry of the same Turn resume instead of re-running every Tool. Failures a
     * retry cannot fix — a limit, an exhausted budget, a misconfigured provider — still drop it,
     * so Tool arguments and outputs are not retained past the Turn that could still use them.
     */
    const finish = async (
      outcome: AgentLoopOutcome,
      type: AgentLoopEventType
    ): Promise<AgentLoopOutcome> => {
      const retryable = outcome.status === "failed" && isRetryableFailure(outcome.reason);
      await this.deps.checkpoints.save({
        businessId: input.businessId,
        runId: input.runId,
        stateId: input.stateId,
        ...counters,
        ...(retryable ? { resume: resumeState() } : {}),
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
    const callModel = async (
      request: ModelInvocationRequest,
      watch: CancelWatch
    ): Promise<ModelInvocationResult> => {
      // A provider that honours the signal rejects the call; one that ignores it runs to
      // completion and is caught by these checks instead. Both have to end the Turn the same way,
      // or a stop would work only against the adapters that chose to implement it.
      const stopped = () => {
        if (watch.cancelled()) throw new TurnCancelled();
      };

      try {
        const stream = this.deps.model.stream?.(request);
        if (stream === undefined) {
          const invoked = await this.deps.model.invoke(request);
          stopped();
          return invoked;
        }

        let completed: ModelInvocationResult | undefined;
        for await (const chunk of stream) {
          stopped();
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
        stopped();
        if (completed === undefined) throw new Error("model stream ended without a result");
        return completed;
      } catch (error) {
        // An abort reaches here as whatever the provider chose to throw, so the watch is what says
        // a stop happened — the error itself cannot be trusted to. A sink failure is never a stop
        // and must keep its own identity.
        if (error instanceof EventSinkFailure) throw error;
        // A stop does not refund what the provider already burned, so whatever partial usage the
        // failure carried is handed on rather than dropped with the error it came in.
        if (watch.cancelled()) {
          throw new TurnCancelled(error instanceof ModelInvocationError ? error.usage : undefined);
        }
        throw error;
      }
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
      let park:
        | { kind: "approval"; approvalId: string; call: NormalizedToolCall }
        | { kind: "child"; childRunId: string; waitId: string; call: NormalizedToolCall }
        | undefined;
      // Which of the declared calls already carry an answer. Tracked by callId rather than by
      // position because the two dispatch paths leave the cursor in different places — the
      // sequential path stops *at* the parked call, the concurrent one has already advanced past
      // the whole batch it is in — so any index arithmetic at park time would be wrong for one of
      // them.
      const answered = new Set<string>();
      // Which of the declared calls actually reached the dispatcher. A call that ran and a call
      // that never ran need different answers at park time: the first may have left an approval
      // pending at the broker, so telling the model to re-issue it would ask for a second one.
      const dispatchedIds = new Set<string>();

      /** Answers one declared call, and records that it now has an answer. */
      const answer = (callId: string, payload: Record<string, unknown>): void => {
        const capped = capToolResult(payload, callId);
        // Shortening changes what the model is given, so it cannot be silent: without this line a
        // Turn that answered from a truncated result looks, in the logs, exactly like one that saw
        // the whole thing. The callId ties it to the `tool_call_dispatched` event that names the
        // Tool.
        if (capped !== payload) {
          this.deps.log?.warn(
            {
              event: "agent_loop.tool_result_capped",
              runId: input.runId,
              stateId: input.stateId,
              iteration: counters.iterations,
              callId,
              maxChars: MAX_TOOL_RESULT_CHARS,
            },
            "tool result exceeded the transcript ceiling and was shortened"
          );
        }
        messages.push(toolMessage(callId, capped));
        answered.add(callId);
      };

      // Applies one dispatched result: records the transcript entry, and reports back either
      // "keep going", the approval this Turn now waits on, or the failure reason that ends it.
      const applyDispatch = async (
        call: { callId: string; name: string; arguments: unknown },
        dispatched: ToolDispatchResult,
        answeredFromCallId?: string
      ): Promise<
        | { kind: "continue" }
        | { kind: "approval"; approvalId: string; call: NormalizedToolCall }
        | { kind: "child"; childRunId: string; waitId: string; call: NormalizedToolCall }
        | { kind: "input_required"; call: NormalizedToolCall }
        | { kind: "fail"; reason: AgentLoopFailureReason }
      > => {
        await emit("tool_call_dispatched", {
          toolName: call.name,
          callId: call.callId,
          outcome: dispatched.status,
          ...(answeredFromCallId === undefined ? {} : { answeredFromCallId }),
        });

        if (dispatched.status === "awaiting_approval") {
          return { kind: "approval", approvalId: dispatched.approvalId, call };
        }

        if (dispatched.status === "awaiting_child") {
          return {
            kind: "child",
            childRunId: dispatched.childRunId,
            waitId: dispatched.waitId,
            call,
          };
        }

        // The barrier is the question, not the answer: once this Turn has asked the operator to
        // decide, nothing else in it may act on the model's own default. A call that reached
        // nobody ends the Turn rather than feeding the model a failure it will route around,
        // which is how an unanswered ask became a rubber stamp (#405).
        if (call.name === REQUEST_INPUT_TOOL) {
          if (dispatched.status !== "succeeded") {
            return { kind: "fail", reason: "input_request_failed" };
          }
          answer(call.callId, { output: dispatched.output });
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
            answer(call.callId, { error: "failed", detail: dispatched.reason });
            return { kind: "continue" };
          }
          counters.repairs += 1;
          if (counters.repairs > input.limits.maxRepairAttempts) {
            return { kind: "fail", reason: "repair_budget_exhausted" };
          }
          answer(call.callId, { error: "invalid_arguments", detail: dispatched.reason });
          return { kind: "continue" };
        }

        if (dispatched.status === "succeeded") {
          const repeatKey = callSignature(call.name, call.arguments);
          const repeats = repeatKey === undefined ? 1 : (repeatCounts.get(repeatKey) ?? 0) + 1;
          if (repeatKey !== undefined) repeatCounts.set(repeatKey, repeats);
          // A repeated `skill` load answers with a Skill that cannot have changed mid-Turn, so the
          // second copy of its text is dropped. The Tool still ran, so the broker still re-checked
          // authorization; only the bytes the model is already holding are left out.
          const output =
            repeats > 1 && call.name === SKILL_TOOL
              ? elideRepeatedSkillText(dispatched.output)
              : dispatched.output;
          // Distilled here rather than inside the Tool: the Tool stays deterministic and
          // replayable, and the model call that shrinks its result lands where every other model
          // call in this Turn already is — budgeted, logged, and visible as second-hand.
          const distilled = await distilledPayload(
            {
              toolName: call.name,
              arguments: call.arguments,
              output,
              ask: askFor(call.arguments, participantAsk),
              policy: input.modelPolicy ?? {},
            },
            this.deps.distiller,
            this.deps.log
          );
          // Through `answer` rather than pushed directly, so this call is recorded as answered.
          // A park later in the same batch backfills whatever is unanswered, and a succeeded call
          // that never registered would be answered a second time with a contradicting result.
          answer(call.callId, {
            ...distilled,
            ...(repeats === 1 ? {} : { repeatedCall: repeatedCall(repeats) }),
          });
          if (isReportTool(call.name)) reported = true;
          if (call.name === SKILL_TOOL) {
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
        answer(call.callId, { error: dispatched.status, detail: dispatched.reason });
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
          answer(call.callId, { error: outcome });
          await emit("tool_call_rejected", { toolName: call.name, callId: call.callId, outcome });
          index += 1;
          continue;
        }

        if (tool.mutating !== false) {
          // Nothing this Turn does next can correct a report the participant has already read, so
          // the effect that report does not describe must not land (#429).
          if (reported) return barrier(call, "effect_after_report");

          // A side-effecting Tool called again with the exact same arguments is refused rather
          // than re-dispatched: unlike an ordinary repeat, running it again is not evidence the
          // model can act on, it is a second real message, issue, or event (#646). Checked before
          // the dispatch — never after, the way an ordinary repeat is counted — because by the
          // time a result comes back the duplicate effect has already happened.
          if (tool.sideEffecting === true) {
            const repeatKey = callSignature(call.name, call.arguments);
            const priorRepeats = repeatKey === undefined ? undefined : repeatCounts.get(repeatKey);
            if (priorRepeats !== undefined) {
              const repeats = priorRepeats + 1;
              if (repeatKey !== undefined) repeatCounts.set(repeatKey, repeats);
              answer(call.callId, { shortCircuitedRepeat: shortCircuitedRepeat(repeats) });
              await emit("tool_call_rejected", {
                toolName: call.name,
                callId: call.callId,
                outcome: "repeated_side_effect",
              });
              index += 1;
              continue;
            }
          }

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
          dispatchedIds.add(call.callId);
          counters.toolCalls += 1;
          const outcome = await applyDispatch(call, dispatched);
          if (outcome.kind === "fail") {
            return finish({ status: "failed", reason: outcome.reason, ...counters }, "failed");
          }
          if (outcome.kind === "approval") {
            park = { kind: "approval", approvalId: outcome.approvalId, call: outcome.call };
            break;
          }
          if (outcome.kind === "child") {
            park = {
              kind: "child",
              childRunId: outcome.childRunId,
              waitId: outcome.waitId,
              call: outcome.call,
            };
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

        // Two identical reads in one batch are one read. They would resolve concurrently against
        // the same state, so the second dispatch re-checks an authorization that cannot have
        // changed since the first, and returns bytes the model is already being handed. This is
        // narrower than the repeat rule in `repeat.ts`, which deliberately re-runs a call repeated
        // in a *later* iteration precisely because the answer may have moved by then; within one
        // batch nothing can have moved. Both calls are still answered, charged, and counted as
        // repeats, so the model sees that it asked twice.
        const firstOfSignature = new Map<string, number>();
        const unique: typeof runBatch = [];
        const resultOf: number[] = [];
        for (const batched of runBatch) {
          const signature = callSignature(batched.name, batched.arguments);
          const seen = signature === undefined ? undefined : firstOfSignature.get(signature);
          if (seen !== undefined) {
            resultOf.push(seen);
            continue;
          }
          if (signature !== undefined) firstOfSignature.set(signature, unique.length);
          resultOf.push(unique.length);
          unique.push(batched);
        }

        // Named only when the batch really is a batch, so that downstream "this ran concurrently"
        // is read off the loop's own dispatch decision rather than guessed from adjacency. Counted
        // after collapsing, not before: two identical reads are dispatched once, so a batch of two
        // that collapses to one ran nothing concurrently and must not claim otherwise.
        //
        // Anchored to the first dispatched call's id rather than its position, because position
        // alone repeats. A crash after these events are emitted but before the checkpoint reruns
        // the iteration at the same index, and a rerun that produced a *different* response would
        // then file its calls under the previous batch's name, leaving Chat to draw two executions
        // as one wider batch. The call ids move with the response, so an exact replay still rebuilds
        // the identical grouping while a divergent one cannot collide with it.
        const batchAnchor = unique[0]?.callId;
        const batchId =
          unique.length > 1 && batchAnchor !== undefined
            ? `${input.stateId}:${counters.iterations}:${batchAnchor}`
            : undefined;

        const distinct = await Promise.all(
          unique.map((batched) =>
            this.deps.tools.dispatch({
              businessId: input.businessId,
              runId: input.runId,
              stateId: input.stateId,
              callId: batched.callId,
              name: batched.name,
              arguments: batched.arguments,
              ...(activeSkillName === undefined ? {} : { activeSkillName }),
              ...(batchId === undefined ? {} : { batchId }),
            })
          )
        );
        const dispatched = resultOf.map((at) => distinct[at]);
        counters.toolCalls += runBatch.length;
        for (const batched of runBatch) dispatchedIds.add(batched.callId);
        index += runBatch.length;

        // Every call in the batch has already run: its effect landed and its Tool-call budget
        // is already spent. So every result is applied — stopping at the first decisive one
        // would drop the rest's transcript entries, dispatch events and repair accounting for
        // work the Run was charged for. Only the *decision* stops: the first decisive outcome
        // in call order wins, matching what a sequential batch would have produced.
        let decision:
          | { kind: "approval"; approvalId: string; call: NormalizedToolCall }
          | { kind: "child"; childRunId: string; waitId: string; call: NormalizedToolCall }
          | { kind: "input_required"; call: NormalizedToolCall }
          | { kind: "fail"; reason: AgentLoopFailureReason }
          | undefined;
        for (let i = 0; i < runBatch.length; i += 1) {
          const batchCall = runBatch[i];
          const batchResult = dispatched[i];
          if (batchCall === undefined || batchResult === undefined) continue;
          // Names the sibling that actually ran, when this call was collapsed into it. The
          // dispatcher never saw this one, so this event is the only record that it was asked.
          const answeredFrom = unique[resultOf[i] ?? -1];
          const answeredFromCallId =
            answeredFrom === undefined || answeredFrom.callId === batchCall.callId
              ? undefined
              : answeredFrom.callId;
          const outcome = await applyDispatch(batchCall, batchResult, answeredFromCallId);
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
          park =
            decision.kind === "approval"
              ? { kind: "approval", approvalId: decision.approvalId, call: decision.call }
              : {
                  kind: "child",
                  childRunId: decision.childRunId,
                  waitId: decision.waitId,
                  call: decision.call,
                };
          break;
        }
        // A batch clipped by budget leaves its remainder at `index`; the next pass re-enters this
        // branch, forms a fresh (now over-budget) peek, and fails via `available <= 0` above
        // rather than ever dispatching past the limit.
      }

      if (park !== undefined) {
        // Why this Turn stopped, in words the model can act on. Both parks replay the parked call
        // on resume, so the distinction the sibling calls need is only what is already pending on
        // their behalf: an operator decision, or a Run that is already doing the work.
        const parked =
          park.kind === "approval"
            ? {
                waitingFor: "approval of an earlier call",
                alsoPending:
                  "If it also needed approval, one is already pending — do not re-issue it.",
              }
            : {
                waitingFor: "a child Run started by an earlier call",
                alsoPending:
                  "If it also started a child Run, that Run is already going — do not re-issue it.",
              };
        // The assistant message above declared every call in the batch, and this park is the only
        // exit that makes that transcript durable. A call sitting after the parked one never
        // dispatched, so nothing answered it — and a proposed Tool call with no matching result is
        // a transcript both Anthropic and OpenAI reject outright, which would fail the resumed
        // Turn at the provider rather than anywhere the loop could repair it. So each one is
        // answered here, before the checkpoint, with a result the model can act on. The parked
        // call is excluded: it is replayed on resume and gets its real result there.
        for (const declared of calls) {
          if (declared.callId === park.call.callId) continue;
          if (answered.has(declared.callId)) continue;
          // A concurrent batch dispatches every call before any outcome is read, so an unanswered
          // one here may already have run. Saying it never ran would be a lie the model acts on:
          // if its own outcome was a second park, that park is already outstanding, and
          // re-issuing the call duplicates whatever it left behind.
          answer(
            declared.callId,
            dispatchedIds.has(declared.callId)
              ? {
                  error: "superseded",
                  detail:
                    `this call ran, but the Turn stopped to wait for ${parked.waitingFor} ` +
                    `in the same batch, so its result was not recorded. ${parked.alsoPending}`,
                }
              : {
                  error: "not_dispatched",
                  detail:
                    `this call never ran: the Turn stopped to wait for ${parked.waitingFor} ` +
                    "in the same batch. Re-issue it if it is still needed.",
                }
          );
        }
        // The parked call is replayed on resume and charged there, so the budget it took on
        // dispatch is given back here — leaving the total at exactly one charge either way. For an
        // approval the call provably never ran, since the dispatcher reports `awaiting_approval`
        // strictly before executing the Tool. For a child it did run and spawned, so its replay
        // must be idempotent on `(runId, callId)` — see `ToolDispatchResult.awaiting_child`.
        // Counters and the transcript are made durable together, so the resumed Turn is charged
        // for exactly what it can still see.
        counters.toolCalls -= 1;
        await checkpoint(park.call);
        await emit(park.kind === "approval" ? "awaiting_approval" : "awaiting_child");
        // Saved again for one reason only: to carry the sequence that event just consumed, so the
        // resumed attempt numbers its events past this one instead of colliding with it. The save
        // above stays first, because a crash between the two must still find durable counters.
        await checkpoint(park.call);
        return park.kind === "approval"
          ? {
              status: "awaiting_approval",
              approvalId: park.approvalId,
              callId: park.call.callId,
              ...counters,
            }
          : {
              status: "awaiting_child",
              childRunId: park.childRunId,
              waitId: park.waitId,
              callId: park.call.callId,
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
      const watch = watchForCancel(() => this.deps.isCancelled(), this.deps.cancelPollMs);
      const request: ModelInvocationRequest = {
        requestId: `${input.runId}:${input.stateId}:${counters.iterations}`,
        modelProfileId: input.modelProfileId,
        messages,
        tools: toolsForIteration(),
        signal: watch.signal,
        ...(attachments.length === 0 ? {} : { attachments }),
        ...(input.modelPolicy === undefined ? {} : { policy: input.modelPolicy }),
        ...(input.principal === undefined ? {} : { principal: input.principal }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      };

      let result: ModelInvocationResult;
      try {
        result = await callModel(request, watch);
      } catch (error) {
        // A model that errors is an outcome the loop owns. A sink that cannot record what already
        // happened is not: the caller must reconcile it, so it escapes rather than being recorded
        // as a model failure through the very sink that just failed.
        if (error instanceof EventSinkFailure) throw error.cause;
        // A stop is something the participant asked for, not something that went wrong. Recording
        // it as a model failure would put a red Turn in front of them for doing what the button
        // offered, and would charge a retry budget against it.
        if (error instanceof TurnCancelled) {
          // Charged on the way out for the same reason a failed call is: a Run started and stopped
          // over and over would otherwise spend against a budget it never touches.
          if (error.usage !== undefined) await chargeUsage(error.usage);
          return finish({ status: "cancelled", ...counters }, "cancelled");
        }
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
      } finally {
        // The poll must not outlive the call it watched, whichever way that call ended.
        watch.stop();
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
