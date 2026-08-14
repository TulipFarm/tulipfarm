import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequirements,
  ModelRequirementsPolicy,
  ModelStreamChunk,
} from "@tulipfarm/agent-runtime";
import { deriveModelRequirements, ModelInvocationError } from "@tulipfarm/agent-runtime";
import { classifyProviderError, priceFor } from "@tulipfarm/llm";
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

/** ModelPort over Soul providers; SDK Tools never execute, so Broker remains sole effect path. */

export interface LlmModelPortOptions {
  /** Resolve per call; requirements can change between loop iterations. */
  model(
    selector: string,
    requirements: ModelRequirements,
    inference?: RunEventEffortInference
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
  /** Governance the request cannot carry — residency, retention, training, sensitivity. */
  readonly policy?: ModelRequirementsPolicy;
  /** Aborts an in-flight model call when the worker is draining. */
  readonly signal?: AbortSignal;
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
    const requirements = deriveModelRequirements(request, this.options.policy);
    const inference = await this.inferEffort(request, requirements);
    const resolution = await this.options.model(request.modelProfileId, requirements, inference);
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
    const startedAt = this.now();
    const result = streamText({
      model: resolution.model,
      messages,
      ...(instructions.length === 0 ? {} : { instructions }),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: toToolSet(request.tools) }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(this.options.signal === undefined ? {} : { abortSignal: this.options.signal }),
    });

    let finishReason: string | undefined;
    let rawFinishReason: string | undefined;

    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text.length > 0) {
        yield { kind: "text_delta", text: part.text };
      }
      if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        rawFinishReason = part.rawFinishReason;
      }
    }

    const [calls, text, usage] = await Promise.all([result.toolCalls, result.text, result.usage]);
    const finishedAt = this.now();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cost = priceFor(pricingModelId(resolution.routing), inputTokens, outputTokens);
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
      const outgoing = {
        instructionCount: instructions.length,
        messageCount: messages.length,
        roles: messages.map((m) => m.role),
        lastMessage: messages.at(-1),
        toolCount: request.tools?.length ?? 0,
        toolNames: request.tools?.map((t) => t.name) ?? [],
      };
      throw new Error(
        `model call produced no output (finishReason=${finishReason ?? "unknown"}` +
          `${rawFinishReason ? `, rawFinishReason=${rawFinishReason}` : ""}, ` +
          `warnings=${JSON.stringify(warnings)}, ` +
          `request=${JSON.stringify(sdkRequest).slice(0, 2000)}, ` +
          `response=${JSON.stringify(sdkResponse).slice(0, 2000)}, ` +
          `outgoing=${JSON.stringify(outgoing).slice(0, 4000)})`
      );
    }

    yield {
      kind: "completed",
      result: {
        requestId: request.requestId,
        output: toOutput(calls, text),
        usage: {
          inputTokens,
          outputTokens,
          ...(cost.costUsd === null ? {} : { costUsd: cost.costUsd }),
        },
      },
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Latest user text only; never let system text or model output escalate effort. */
function latestUserPrompt(messages: readonly ModelMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (message.content.trim().length === 0) continue;
    return message.content;
  }
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
