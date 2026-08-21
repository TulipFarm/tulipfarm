import { createHash } from "node:crypto";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelPort,
  ModelRequirements,
  ModelRequirementsPolicy,
  ModelStreamChunk,
  ModelUsage,
} from "@tulipfarm/agent-runtime";
import { deriveModelRequirements, ModelInvocationError } from "@tulipfarm/agent-runtime";
import type { PrincipalRef } from "@tulipfarm/llm";
import { classifyProviderError, decidePromptCache } from "@tulipfarm/llm";
import {
  splitPrompt,
  stablePrefixChars,
  tokenDetail,
  toOutput,
  toToolSet,
  UsageAccumulator,
  withCacheBreakpoint,
} from "@tulipfarm/model-adapter";
import type { ResolvedLimits } from "@tulipfarm/run-kernel";
import {
  asEffortPreset,
  contentText,
  type EffortRung,
  isEffortRung,
  LlmNotConfiguredError,
  type RunEventEffortInference,
  type RunEventPayloads,
} from "@tulipfarm/schema";
import { type ModelMessage as SdkMessage, streamText } from "ai";
import type { EffortInferencePort } from "./effort-inference";
import type { LlmModelResolution } from "./llm";
import type { ModelCallGate } from "./model-gate";
import { ModelCallWatchdog, withAbort } from "./model-watchdog";
import type { SpendSink } from "./observability";

/** ModelPort over Soul providers; SDK Tools never execute, so Broker remains sole effect path. */

export interface LlmModelPortOptions {
  /** Resolve per call; requirements can change between loop iterations. */
  model(
    selector: string,
    requirements: ModelRequirements,
    inference?: RunEventEffortInference,
    principal?: PrincipalRef,
    gate?: ModelCallGate
  ): Promise<LlmModelResolution>;
  /** Optional `auto` effort inference; consulted once per Turn-attempt port instance. */
  readonly effort?: EffortInferencePort;
  /**
   * Optional because tests and non-Run callers may use this port, but Chat wires it from the
   * per-attempt writer so the routing event is keyed with the Run/State identity that selected it.
   */
  readonly routingEvents?: {
    emit(
      type: "model.routed",
      payload: RunEventPayloads["model.routed"],
      key: string
    ): Promise<void>;
  };
  /** Opens write-once Run budgets from the selected ModelProfile before the call spends them. */
  readonly budgets?: {
    open(limits: ResolvedLimits): Promise<void>;
  };
  /**
   * Process-wide governance floor, used only when a request carries no policy of its own.
   *
   * Per-turn governance belongs on `ModelInvocationRequest.policy`: this port is constructed
   * before the turn's Context resolves, so it cannot know which Agent is acting.
   */
  readonly policy?: ModelRequirementsPolicy;
  /** Aborts an in-flight model call when the worker is draining. */
  readonly signal?: AbortSignal;
  /** Overrides the default idle bound; a chunk of any kind restarts it. */
  readonly stallTimeoutMs?: number;
  /** Overrides the default absolute ceiling for one call. */
  readonly callTimeoutMs?: number;
  /**
   * Per-provider concurrency cap and circuit breaker. Shared across turns, so it must be one
   * instance per process rather than one per port.
   */
  readonly gate?: ModelCallGate;
  /** Where each model call is reported as spend. Best-effort; never blocks the turn. */
  readonly spend?: SpendSink;
  /** The Conversation this port serves, for attributing spend. Absent for Routine Runs. */
  readonly conversationId?: string;
  /** Test hook for deterministic latency measurement. Defaults to `Date.now`. */
  now?(): number;
}

import type { ModelCallReceipt, ModelCallReceiptSource } from "@tulipfarm/turn-executor";

export type { ModelCallReceipt, ModelCallReceiptSource } from "@tulipfarm/turn-executor";

export class LlmModelPort implements ModelPort, ModelCallReceiptSource {
  private receipt: ModelCallReceipt | undefined;
  /** Cached effort decision; `undefined` is a real inferred result and must not re-run. */
  private effort: { readonly value: RunEventEffortInference | undefined } | undefined;

  constructor(private readonly options: LlmModelPortOptions) {}

  /** The last completed model call on this port, or `undefined` when none completed. */
  latestModelCallReceipt(): ModelCallReceipt | undefined {
    return this.receipt;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    for await (const chunk of this.stream(request)) {
      if (chunk.kind === "completed") return chunk.result;
    }
    throw new Error("model stream ended without a result");
  }

  async *stream(request: ModelInvocationRequest): AsyncIterable<ModelStreamChunk> {
    const requirements = deriveModelRequirements(request, request.policy ?? this.options.policy);
    const inference = await this.inferEffort(request, requirements);
    let resolution: LlmModelResolution;
    try {
      resolution = await this.options.model(
        request.modelProfileId,
        requirements,
        inference,
        request.principal,
        this.options.gate
      );
    } catch (error) {
      throw new ModelInvocationError(
        error instanceof LlmNotConfiguredError
          ? "model_not_configured"
          : classifyProviderError(error),
        error
      );
    }
    if (resolution.kind === "available" && resolution.budgetLimits !== undefined) {
      await this.options.budgets?.open(resolution.budgetLimits);
    }
    await this.options.routingEvents?.emit(
      "model.routed",
      resolution.routing,
      `model:${request.requestId}`
    );
    if (resolution.kind === "denied") {
      throw new ModelInvocationError(
        resolution.routing.reason === "unknown_profile" ? "model_not_configured" : "model_error",
        new Error(denialMessage(resolution.routing, requirements))
      );
    }

    try {
      yield* this.streamProvider(request, resolution);
    } catch (error) {
      // Re-classifying an already-classified failure would read the wrapper rather than the
      // provider's own error and flatten every reason to `model_error`.
      if (error instanceof ModelInvocationError) throw error;
      throw new ModelInvocationError(classifyProviderError(error), error);
    }
  }

  /** Infer only `auto`, from the latest user message so effort tracks difficulty, not age. */
  private async inferEffort(
    request: ModelInvocationRequest,
    requirements: ModelRequirements
  ): Promise<RunEventEffortInference | undefined> {
    if (this.options.effort === undefined) return undefined;
    if (asEffortPreset(request.modelProfileId) !== "auto") return undefined;
    if (this.effort !== undefined) return this.effort.value;

    const prompt = latestUserPrompt(request.messages);
    const value =
      prompt === undefined ? undefined : await this.options.effort.infer(prompt, requirements);
    this.effort = { value };
    return value;
  }

  private async *streamProvider(
    request: ModelInvocationRequest,
    resolution: Extract<LlmModelResolution, { kind: "available" }>
  ): AsyncIterable<ModelStreamChunk> {
    const { instructions, messages } = splitPrompt(request.messages, request.attachments);
    // Caching is charged on this path whether or not it was asked for, so the ask happens here
    // rather than being left to whatever each provider does by default.
    const prompt = withCacheBreakpoint(
      instructions,
      decidePromptCache({
        provider: resolution.provider,
        modelId: routedModelId(resolution.routing),
        cacheAllowed: routedCacheAllowed(resolution.routing),
        prefixChars: stablePrefixChars(instructions, request.tools),
      })
    );
    const startedAt = this.now();
    const watchdog = new ModelCallWatchdog({
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      ...(this.options.stallTimeoutMs === undefined
        ? {}
        : { stallTimeoutMs: this.options.stallTimeoutMs }),
      ...(this.options.callTimeoutMs === undefined
        ? {}
        : { callTimeoutMs: this.options.callTimeoutMs }),
    });

    let finishReason: string | undefined;
    let rawFinishReason: string | undefined;
    // Accumulated as the stream runs, not read from the terminal chunk: a call that dies
    // mid-stream never produces that chunk, and the provider still bills for what it did.
    const observed = new UsageAccumulator();
    let streamError: Error | undefined;
    let calls: Awaited<ReturnType<typeof streamText>["toolCalls"]>;
    let text: string;
    let usage: Awaited<ReturnType<typeof streamText>["usage"]>;
    let result: ReturnType<typeof streamText>;

    try {
      result = streamText({
        model: resolution.model,
        messages,
        ...(prompt.length === 0 ? {} : { instructions: prompt }),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: toToolSet(request.tools) }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        abortSignal: watchdog.signal,
      });

      for await (const part of withAbort(result.fullStream, watchdog.signal)) {
        // Any part at all is proof of life, so the stall window restarts on tool calls and
        // reasoning too, not only on visible text.
        watchdog.progress();
        if (part.type === "text-delta" && part.text.length > 0) {
          yield { kind: "text_delta", text: part.text };
        }
        if (part.type === "error") {
          // Deliberately not thrown here. The SDK reports the step's usage in the `finish-step`
          // part that follows the `error` part, so bailing out on sight is precisely what made
          // every mid-stream failure look free while the provider still billed for it.
          streamError = part.error instanceof Error ? part.error : new Error(String(part.error));
          continue;
        }
        // Every step reports its own usage; `finish` repeats the total, so counting only the
        // steps keeps one source and cannot double-charge.
        if (part.type === "finish-step") observed.add(part.usage);
        if (part.type === "finish") {
          finishReason = part.finishReason;
          rawFinishReason = part.rawFinishReason;
        }
      }

      if (streamError !== undefined) throw streamError;

      [calls, text, usage] = await Promise.all([result.toolCalls, result.text, result.usage]);
    } catch (error) {
      // A watchdog abort must not be reported as a generic provider error: the operator needs to
      // know the call was cut off here, and by which bound.
      // Whatever the provider consumed before it stopped rides out on the error, so the Run is
      // charged for a failed call instead of being handed it free.
      const partial = observed.settle((tokensIn, tokensOut) =>
        resolution.price(tokensIn, tokensOut)
      );
      this.reportSpend(request, resolution, "error", partial, this.now() - startedAt);
      if (watchdog.expired !== undefined) {
        throw new ModelInvocationError(
          "model_provider_unavailable",
          new Error(`${watchdog.message()} — model call aborted`, { cause: error }),
          partial
        );
      }
      throw error instanceof ModelInvocationError
        ? new ModelInvocationError(error.reason, error.cause, partial, error.modelId)
        : new ModelInvocationError(
            classifyProviderError(error),
            error,
            partial,
            resolution.attemptedModelId?.()
          );
    } finally {
      watchdog.close();
    }

    const finishedAt = this.now();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    // Priced after the call, against the chain link that actually answered — never the head of
    // the chain, which is a prediction rather than an outcome.
    const cost = resolution.price(inputTokens, outputTokens);
    this.receipt =
      receiptFromRouting(resolution.routing, Math.max(0, Math.round(finishedAt - startedAt))) ??
      this.receipt;

    // ai@7 can emit `finish` without running the provider; treat empty calls/text/usage as a fault.
    if (
      calls.length === 0 &&
      text.length === 0 &&
      (usage.inputTokens ?? 0) === 0 &&
      (usage.outputTokens ?? 0) === 0
    ) {
      const [warnings, sdkRequest, sdkResponse] = await Promise.all([
        Promise.resolve(result.warnings).catch((error: unknown) => [
          { toString: () => String(error) },
        ]),
        Promise.resolve(result.request).catch((error: unknown) => ({ body: String(error) })),
        Promise.resolve(result.response).catch((error: unknown) => ({ body: String(error) })),
      ]);
      // Shapes and fingerprints only. This message reaches the operator's process logs, and the
      // request body is the assembled prompt while the response body is the model's answer — both
      // are the participant's business content, which no amount of truncation makes safe to spill
      // there. A digest still correlates repeat failures and still says how big the call was.
      const outgoing = {
        instructionCount: instructions.length,
        messageCount: messages.length,
        roles: messages.map((m) => m.role),
        lastMessage: describeMessage(messages.at(-1)),
        toolCount: request.tools?.length ?? 0,
        toolNames: request.tools?.map((t) => t.name) ?? [],
      };
      throw new Error(
        `model call produced no output (finishReason=${finishReason ?? "unknown"}` +
          `${rawFinishReason ? `, rawFinishReason=${rawFinishReason}` : ""}, ` +
          `warnings=${JSON.stringify(warnings)}, ` +
          `request=${fingerprint(sdkRequest)}, ` +
          `response=${describeResponse(sdkResponse)}, ` +
          `outgoing=${JSON.stringify(outgoing)})`
      );
    }

    const finalUsage: ModelUsage = {
      inputTokens,
      outputTokens,
      ...tokenDetail(usage),
      ...(cost.kind === "priced" ? { costUsd: cost.costUsd } : {}),
      costBasis: cost.kind,
    };
    this.reportSpend(request, resolution, "ok", finalUsage, finishedAt - startedAt);

    yield {
      kind: "completed",
      result: {
        requestId: request.requestId,
        output: toOutput(calls, text),
        usage: finalUsage,
      },
    };
  }

  /**
   * Reports one model call to the spend ledger.
   *
   * Failures are reported too, with whatever the provider had already consumed: a call that dies
   * mid-stream is billed by the provider, so leaving it out of the ledger understates real spend
   * by exactly the amount an operator most wants to see.
   */
  private reportSpend(
    request: ModelInvocationRequest,
    resolution: Extract<LlmModelResolution, { kind: "available" }>,
    status: "ok" | "error",
    usage: ModelUsage | undefined,
    durationMs: number
  ): void {
    if (this.options.spend === undefined) return;
    this.options.spend.recordLlmCall({
      status,
      durationMs: Math.max(0, Math.round(durationMs)),
      ...(usage === undefined ? {} : { usage }),
      ...(this.options.conversationId === undefined
        ? {}
        : { conversationId: this.options.conversationId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(routedModelId(resolution.routing) === undefined
        ? {}
        : { model: routedModelId(resolution.routing) }),
      ...(resolution.provider === undefined ? {} : { provider: resolution.provider }),
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Latest user text only; never let system text or model output escalate effort. */
/**
 * A non-reversible tag plus a size for a payload that must not be logged verbatim.
 *
 * Two failures with the same digest are the same call shape, which is what a diagnostic is
 * actually for; the content itself is the participant's, not the operator's.
 */
function fingerprint(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "undefined";
  } catch {
    json = "unserializable";
  }
  return `sha256:${createHash("sha256").update(json).digest("hex").slice(0, 12)}/${json.length}b`;
}

/** Provider call metadata is operational; the body is content, so it is only fingerprinted. */
function describeResponse(response: unknown): string {
  const r = response as { id?: unknown; modelId?: unknown; timestamp?: unknown } | null | undefined;
  const meta = {
    id: typeof r?.id === "string" ? r.id : undefined,
    modelId: typeof r?.modelId === "string" ? r.modelId : undefined,
    timestamp: r?.timestamp instanceof Date ? r.timestamp.toISOString() : undefined,
  };
  return `${JSON.stringify(meta)}@${fingerprint(response)}`;
}

/** Role and part shape of a message, with sizes instead of text. */
function describeMessage(message: SdkMessage | undefined): unknown {
  if (!message) return undefined;
  const { role, content } = message;
  if (typeof content === "string")
    return { role, parts: [{ type: "text", chars: content.length }] };
  if (!Array.isArray(content)) return { role, parts: [] };
  return {
    role,
    parts: content.map((part) => {
      const p = part as { type?: unknown; text?: unknown };
      return {
        type: typeof p.type === "string" ? p.type : "unknown",
        chars: typeof p.text === "string" ? p.text.length : undefined,
      };
    }),
  };
}

/**
 * Why routing refused, in terms of what the request actually asked for.
 *
 * A modality denial names the modalities rather than reporting `modality_unsupported`, because
 * that reason alone leaves an operator to guess whether the attachment, the model or the profile
 * is at fault. This is the whole visible outcome of attaching a File to a text-only model — the
 * OpenAI-compatible adapter behind Ollama, vLLM and LM Studio being the common case — so it has
 * to say which modality was wanted and which model would not take it.
 */
function denialMessage(
  routing: { readonly profileId: string; readonly reason?: string },
  requirements: ModelRequirements
): string {
  const denied = `model profile "${routing.profileId}" denied: ${routing.reason}`;
  if (routing.reason !== "modality_unsupported") return denied;
  const wanted = (requirements.inputModalities ?? []).filter((m) => m !== "text");
  if (wanted.length === 0) return denied;
  return `${denied} — this turn needs ${wanted.join(" and ")} input, which no model in the profile accepts`;
}

function latestUserPrompt(messages: readonly ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = contentText(message.content);
    if (text.trim().length === 0) continue;
    return text;
  }
  return undefined;
}

/**
 * The model the ledger attributes this call to.
 *
 * Wider than `pricingModelId`, which reports only chain heads: a raw model id is still a real
 * model and a spend row that cannot name it is a spend row nobody can act on.
 */
function routedModelId(routing: RunEventPayloads["model.routed"]): string | undefined {
  if (routing.outcome === "selected") return routing.chain[0]?.modelId;
  if (routing.outcome === "raw_model") return routing.modelId;
  return undefined;
}

function pricingModelId(routing: RunEventPayloads["model.routed"]): string | undefined {
  if (routing.outcome === "selected") return routing.chain[0]?.modelId;
  return undefined;
}

/** Actual rung, including inferred routes that name the rung before profile resolution. */
function appliedRung(
  routing: Extract<RunEventPayloads["model.routed"], { outcome: "selected" }>
): EffortRung | undefined {
  if (routing.resolution === "effort_inferred") return routing.effortInference?.rung;
  return isEffortRung(routing.profileId) ? routing.profileId : undefined;
}

function receiptFromRouting(
  routing: RunEventPayloads["model.routed"],
  modelCallLatencyMs: number
): ModelCallReceipt | undefined {
  const modelId = pricingModelId(routing);
  if (modelId === undefined) return undefined;
  // Preserve `auto` as the participant's selector; the inferred rung is not what they picked.
  const byEffort =
    routing.outcome === "selected" &&
    (routing.resolution === "effort_preset" || routing.resolution === "effort_inferred")
      ? routing
      : undefined;
  const effortPreset = byEffort === undefined ? undefined : asEffortPreset(byEffort.selector);
  // Claim a rung only when the resolved profile or inferred route honestly names one.
  const effortApplied = byEffort === undefined ? undefined : appliedRung(byEffort);
  return {
    modelId,
    ...(effortPreset === undefined ? {} : { effortPreset }),
    ...(effortApplied === undefined ? {} : { effortApplied }),
    modelCallLatencyMs,
  };
}

/** Routing's caching allowance; `undefined` when no profile decided, which is not the same as no. */
function routedCacheAllowed(routing: RunEventPayloads["model.routed"]): boolean | undefined {
  return routing.outcome === "selected" ? routing.cacheAllowed : undefined;
}
