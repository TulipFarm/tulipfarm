import { createHash } from "node:crypto";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequirements,
  ModelRequirementsPolicy,
  ModelStreamChunk,
  ModelUsage,
} from "@tulipfarm/agent-runtime";
import { deriveModelRequirements, ModelInvocationError } from "@tulipfarm/agent-runtime";
import type { CostBasis, PrincipalRef, PromptCacheDecision } from "@tulipfarm/llm";
import { classifyProviderError, decidePromptCache } from "@tulipfarm/llm";
import type { ResolvedLimits } from "@tulipfarm/run-kernel";
import {
  asEffortPreset,
  type EffortPreset,
  type EffortRung,
  isEffortRung,
  type RunEventEffortInference,
  type RunEventPayloads,
} from "@tulipfarm/schema";
import {
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage as SdkMessage,
  type SystemModelMessage,
  streamText,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  tool,
} from "ai";
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
    principal?: PrincipalRef
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

export interface ModelCallReceipt {
  readonly modelId: string;
  /** What the participant asked for — including `auto`, which is a request, not an outcome. */
  readonly effortPreset?: EffortPreset;
  /** Actual rung, when knowable, so clients can escalate `auto` without guessing. */
  readonly effortApplied?: EffortRung;
  readonly modelCallLatencyMs: number;
}

/** Latest-call receipt is scoped to this Turn-attempt port, not a process registry. */
export interface ModelCallReceiptSource {
  latestModelCallReceipt(): ModelCallReceipt | undefined;
}

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
    const resolution = await this.options.model(
      request.modelProfileId,
      requirements,
      inference,
      request.principal
    );
    if (resolution.kind === "available" && resolution.budgetLimits !== undefined) {
      await this.options.budgets?.open(resolution.budgetLimits);
    }
    await this.options.routingEvents?.emit(
      "model.routed",
      resolution.routing,
      `model:${request.requestId}`
    );
    if (resolution.kind === "denied") {
      throw new Error(
        `model profile "${resolution.routing.profileId}" denied: ${resolution.routing.reason}`
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
    const { instructions, messages } = splitPrompt(request.messages);
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
    // Held for the whole call: releasing early would let the next turn in while this one is
    // still occupying a provider connection.
    const lease = await this.options.gate?.acquire(resolution.provider ?? "unknown");
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
      lease?.succeeded();
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
        lease?.failed("model_provider_unavailable");
        throw new ModelInvocationError(
          "model_provider_unavailable",
          new Error(`${watchdog.message()} — model call aborted`, { cause: error }),
          partial
        );
      }
      lease?.failed(classifyProviderError(error));
      throw error instanceof ModelInvocationError
        ? new ModelInvocationError(error.reason, error.cause, partial)
        : new ModelInvocationError(classifyProviderError(error), error, partial);
    } finally {
      watchdog.close();
      lease?.release();
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

function latestUserPrompt(messages: readonly ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (message.content.trim().length === 0) continue;
    return message.content;
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

/** Tool calls outrank text; narration before a call is not the final answer. */
function toOutput(
  calls: Awaited<ReturnType<typeof streamText>["toolCalls"]>,
  text: string
): ModelOutput {
  if (calls.length > 0) {
    return {
      kind: "tool_calls",
      calls: calls.map((call) => ({
        callId: call.toolCallId,
        name: call.toolName,
        arguments: call.input,
      })),
    };
  }
  return { kind: "text", text };
}

/** Routing's caching allowance; `undefined` when no profile decided, which is not the same as no. */
function routedCacheAllowed(routing: RunEventPayloads["model.routed"]): boolean | undefined {
  return routing.outcome === "selected" ? routing.cacheAllowed : undefined;
}

/**
 * Size of the part of the prompt that repeats unchanged between turns.
 *
 * Tool declarations sit ahead of the instructions in the provider's cacheable prefix and are just
 * as stable, so leaving them out would under-measure a prompt that is mostly tool schemas.
 */
function stablePrefixChars(
  instructions: readonly SystemModelMessage[],
  tools: ModelInvocationRequest["tools"]
): number {
  const instructionChars = instructions.reduce((total, m) => total + m.content.length, 0);
  const toolChars = (tools ?? []).reduce(
    (total, t) =>
      total + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.inputSchema).length,
    0
  );
  return instructionChars + toolChars;
}

/**
 * Marks the end of the stable prefix so the provider caches everything up to it.
 *
 * Only the last instruction is marked: a breakpoint covers everything before it, so marking each
 * block would spend the provider's limited breakpoints for no extra coverage. The annotation is
 * namespaced by provider, so a chain that falls back across vendors carries an option the
 * answering provider ignores rather than one it misreads.
 */
function withCacheBreakpoint(
  instructions: readonly SystemModelMessage[],
  decision: PromptCacheDecision
): SystemModelMessage[] {
  if (decision.kind === "skip") return [...instructions];
  const last = instructions.length - 1;
  return instructions.map((message, index) =>
    index === last ? { ...message, providerOptions: decision.providerOptions } : message
  );
}

/** Convert loop transcript to SDK prompt; tool results stay attributed to their tool calls. */
function splitPrompt(transcript: readonly { role: string; content: string }[]): {
  instructions: SystemModelMessage[];
  messages: SdkMessage[];
} {
  const instructions: SystemModelMessage[] = [];
  const messages: SdkMessage[] = [];
  const toolNamesByCallId = new Map<string, string>();
  let pendingResults: ToolResultPart[] = [];

  const flushResults = () => {
    if (pendingResults.length > 0) {
      messages.push({ role: "tool", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of transcript) {
    if (message.role === "system") {
      flushResults();
      instructions.push({ role: "system", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const calls = parseToolCalls(message.content);
      if (calls === undefined) {
        flushResults();
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      flushResults();
      for (const call of calls) toolNamesByCallId.set(call.callId, call.name);
      const parts: ToolCallPart[] = calls.map((call) => ({
        type: "tool-call",
        toolCallId: call.callId,
        toolName: call.name,
        input: call.arguments,
      }));
      messages.push({ role: "assistant", content: parts });
      continue;
    }

    if (message.role === "tool") {
      const result = parseToolResult(message.content);
      if (result !== undefined) {
        pendingResults.push({
          type: "tool-result",
          toolCallId: result.callId,
          toolName: toolNamesByCallId.get(result.callId) ?? "unknown",
          output: { type: "text", value: JSON.stringify(result.payload) },
        });
        continue;
      }
    }

    flushResults();
    messages.push({ role: "user", content: message.content });
  }
  flushResults();
  return { instructions, messages };
}

/** Recognizes loop-encoded Tool calls; other assistant text passes through. */
function parseToolCalls(
  content: string
): readonly { callId: string; name: string; arguments: unknown }[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model output that is not valid JSON yields no tool call.
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("toolCalls" in parsed) ||
    !Array.isArray((parsed as { toolCalls: unknown }).toolCalls)
  ) {
    return undefined;
  }
  return (parsed as { toolCalls: unknown[] }).toolCalls.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { callId?: unknown }).callId !== "string" ||
      typeof (entry as { name?: unknown }).name !== "string"
    ) {
      return [];
    }
    const call = entry as { callId: string; name: string; arguments: unknown };
    return [{ callId: call.callId, name: call.name, arguments: call.arguments }];
  });
}

/** Recognizes the loop's `toolMessage` encoding: `{ callId, ...payload }`. */
function parseToolResult(
  content: string
): { callId: string; payload: Record<string, unknown> } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model output that is not valid JSON yields no tool call.
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { callId?: unknown }).callId !== "string"
  ) {
    return undefined;
  }
  const { callId, ...payload } = parsed as { callId: string } & Record<string, unknown>;
  return { callId, payload };
}

function toToolSet(
  tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[]
): ToolSet {
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ])
  );
}

/**
 * Cache and reasoning splits.
 *
 * Zeros are dropped alongside absent values: providers that support none of this still report
 * `0`, and carrying that into every record would bloat the stored attributes without saying
 * anything a missing key does not already say.
 */
function tokenDetail(usage: LanguageModelUsage): Partial<ModelUsage> {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
  };
}

/**
 * Running total of what a streaming call has consumed so far.
 *
 * Exists for the failure path. Usage was only ever read from the terminal chunk, which a call
 * that dies mid-stream never reaches — so every mid-stream failure was charged zero while the
 * provider billed for the submitted prompt and the partial output that had already been
 * streamed to, and durably stored for, the participant.
 */
class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private reasoningTokens = 0;

  add(usage: LanguageModelUsage): void {
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    this.reasoningTokens += usage.outputTokenDetails?.reasoningTokens ?? 0;
  }

  /**
   * Prices what was consumed, or reports nothing when no tokens were.
   *
   * The SDK synthesises a zero-usage step for a call that failed before the provider answered,
   * so "reported something" is not a usable test. Zero tokens is nothing to charge on either
   * reading, and reporting absence keeps a meaningless record out of the spend ledger.
   */
  settle(price: (tokensIn: number, tokensOut: number) => CostBasis): ModelUsage | undefined {
    if (this.inputTokens === 0 && this.outputTokens === 0) return undefined;
    const cost = price(this.inputTokens, this.outputTokens);
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheReadTokens === 0 ? {} : { cacheReadTokens: this.cacheReadTokens }),
      ...(this.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: this.cacheWriteTokens }),
      ...(this.reasoningTokens === 0 ? {} : { reasoningTokens: this.reasoningTokens }),
      ...(cost.kind === "priced" ? { costUsd: cost.costUsd } : {}),
      costBasis: cost.kind,
    };
  }
}
