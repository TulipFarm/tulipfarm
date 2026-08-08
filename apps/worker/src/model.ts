import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelOutput,
  ModelPort,
  ModelRequirements,
  ModelRequirementsPolicy,
  ModelStreamChunk,
} from "@tulipfarm/agent-runtime";
import { deriveModelRequirements } from "@tulipfarm/agent-runtime";
import { priceFor } from "@tulipfarm/llm";
import type { ResolvedLimits } from "@tulipfarm/run-kernel";
import {
  asEffortPreset,
  type EffortPreset,
  type EffortRung,
  isEffortRung,
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
import type { LlmModelResolution } from "./llm";

/**
 * `ModelPort` over the Soul's configured providers (plan §2).
 *
 * The Agent loop owns the Tool loop, so the Tools declared here deliberately have **no** `execute`:
 * the provider stops at the tool call and hands it back, and dispatch goes through the Tool Broker
 * where authorization and effects belong. Letting the SDK run a Tool would put an effect path
 * beside the broker, which is exactly the second authority the architecture forbids.
 *
 * Streaming is the primary path because a participant should see text as it is produced; `invoke`
 * is the same call drained to its result, so a caller that only wants the outcome behaves
 * identically.
 */

export interface LlmModelPortOptions {
  /**
   * The provider for a resolved selector. Asked per call rather than held, so a Soul that
   * republishes its providers mid-turn is honoured on the next iteration instead of on restart.
   * Requirements travel with the request because routing must re-check them per call: a turn that
   * gains a Tool halfway through is a different question of the model than the one that started it.
   */
  model(selector: string, requirements: ModelRequirements): Promise<LlmModelResolution>;
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
  /**
   * The rung the call actually ran at, when it can be named.
   *
   * Without this, a client that wants the *next* rung up from an `auto` answer has to guess which
   * rung `auto` meant, and guessing wrong skips a rung. Absent when a preset maps to an authored
   * ModelProfile that is not itself a rung, where no honest rung name exists.
   */
  readonly effortApplied?: EffortRung;
  readonly modelCallLatencyMs: number;
}

/**
 * Reads the receipt for the most recent model call a port served. Chat builds one port per Turn
 * attempt, so the receipt is scoped by that instance rather than by a process-wide registry: a
 * registry keyed by Run would outlive the turns that wrote it, and a Turn that parks on an approval
 * and resumes would attach the pre-approval call's receipt to the reply that followed it.
 */
export interface ModelCallReceiptSource {
  latestModelCallReceipt(): ModelCallReceipt | undefined;
}

export class LlmModelPort implements ModelPort, ModelCallReceiptSource {
  private receipt: ModelCallReceipt | undefined;

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
    const { instructions, messages } = splitPrompt(request.messages);
    const resolution = await this.options.model(
      request.modelProfileId,
      deriveModelRequirements(request, this.options.policy)
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

    // A stream that ended cleanly (no `error` part above) but produced no tool calls, no text, and
    // no usage is not a real completion — the provider call never actually ran (`ai@7`'s internal
    // step pipeline can reach `finish` this way on certain setup failures without ever emitting an
    // `error` part). Surfacing it as `completed` with blank text sends the loop into its
    // silent-retry repair budget instead of the real diagnosis.
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

function pricingModelId(routing: RunEventPayloads["model.routed"]): string | undefined {
  if (routing.outcome === "raw_model") return routing.modelId;
  if (routing.outcome === "selected") return routing.chain[0]?.modelId;
  return undefined;
}

function receiptFromRouting(
  routing: RunEventPayloads["model.routed"],
  modelCallLatencyMs: number
): ModelCallReceipt | undefined {
  const modelId = pricingModelId(routing);
  if (modelId === undefined) return undefined;
  const selectedByPreset = routing.outcome === "selected" && routing.resolution === "effort_preset";
  const effortPreset = selectedByPreset ? asEffortPreset(routing.selector) : undefined;
  // `deriveModelProfiles` ids a preset's head profile by the preset's own name, so the resolved
  // profile id *is* the rung whenever the deployment routes on derived profiles. When a preset
  // points at an authored ModelProfile instead, the id names that profile and no rung is claimed.
  const effortApplied =
    selectedByPreset && isEffortRung(routing.profileId) ? routing.profileId : undefined;
  return {
    modelId,
    ...(effortPreset === undefined ? {} : { effortPreset }),
    ...(effortApplied === undefined ? {} : { effortApplied }),
    modelCallLatencyMs,
  };
}

/**
 * A model answer as the loop reads it.
 *
 * Tool calls win over text when both are present: a provider that narrates before calling has not
 * answered yet, and treating that narration as the answer would end the turn one step early.
 */
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

/**
 * The loop's flat transcript as a provider prompt.
 *
 * System messages are separated out: the SDK refuses them inside `messages` and takes them through
 * `instructions`, which is also the honest shape — an instruction is not a turn in the
 * conversation, and their order relative to the transcript carries no meaning.
 *
 * An `assistant` message that records the loop's own proposed tool calls (see
 * `assistantToolCallMessage` in the loop) is rendered as real `tool-call` parts, and the `tool`
 * messages answering them are rendered as `tool-result` parts on the toolCallId they name. Without
 * this the result would arrive as an unattributed user message and the provider — and the model
 * reading it — would have no way to tell it is feedback on the model's own last action, which is
 * why a rejected call used to repeat forever instead of being corrected.
 */
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

/** Recognizes the loop's `assistantToolCallMessage` encoding; any other assistant text passes through. */
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
