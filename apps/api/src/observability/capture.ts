import type { ResolvedModelEntry } from "@tulipfarm/llm";

/**
 * The subset of the AI SDK v7 `streamText` StepResult that observability reads. The chat turn's
 * `PersistableStep` (turn-helpers.ts) deliberately omits `usage`/`response`; we read the real step
 * via this shape instead. NOTE: the consumer-facing `step.usage` (AI SDK `LanguageModelUsage`) is
 * FLAT — `inputTokens: number` with cache details nested under `inputTokenDetails` — NOT the nested
 * provider-level shape. Reading `inputTokens.total` (the provider shape) yields 0 for every call.
 */
export interface ObservableUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } | null;
  outputTokenDetails?: { textTokens?: number; reasoningTokens?: number } | null;
}

export interface ObservableStep {
  usage?: ObservableUsage | null;
  response?: { modelId?: string } | null;
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
  toolResults?: ReadonlyArray<{ toolName: string; output?: unknown }>;
}

export interface ToolCallInfo {
  name: string;
  status: "ok" | "error";
  errorCode?: string;
  /** Argument + result bodies — carried for opt-in content capture; the subscriber drops them
   *  unless capture is enabled. Never persisted by default. */
  args?: unknown;
  result?: unknown;
}

/**
 * Derive per-tool outcomes from a finished step's tool results: name + ok/error + error code, plus
 * the arg/result bodies (used only when content capture is on). A `ToolCallResult` is
 * `{success:false, error:{code}}` on failure; anything else is treated as ok.
 */
export function extractToolCalls(step: ObservableStep): ToolCallInfo[] {
  const argsByName = new Map<string, unknown>();
  for (const tc of step.toolCalls ?? []) {
    if (!argsByName.has(tc.toolName)) argsByName.set(tc.toolName, tc.input);
  }
  return (step.toolResults ?? []).map((tr) => {
    const out = tr.output as { success?: boolean; error?: { code?: string } } | undefined;
    const base = { args: argsByName.get(tr.toolName), result: tr.output };
    if (out?.success === false) {
      return { name: tr.toolName, status: "error", errorCode: out.error?.code, ...base };
    }
    return { name: tr.toolName, status: "ok", ...base };
  });
}

export interface StepUsage {
  tokensIn: number;
  tokensOut: number;
  /** The model the provider actually served (flows through the fallback chain), or null if absent. */
  servedModelId: string | null;
  /** Prompt-cache + reasoning breakdown, stashed in attributes for later cache-aware pricing. */
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Pull token totals + the served model id off a finished step (flat v7 `LanguageModelUsage`). */
export function extractStepUsage(step: ObservableStep): StepUsage {
  const u = step.usage ?? undefined;
  return {
    tokensIn: u?.inputTokens ?? 0,
    tokensOut: u?.outputTokens ?? 0,
    servedModelId: step.response?.modelId ?? null,
    cacheRead: u?.inputTokenDetails?.cacheReadTokens,
    cacheWrite: u?.inputTokenDetails?.cacheWriteTokens,
    reasoning: u?.outputTokenDetails?.reasoningTokens,
  };
}

/**
 * Attribute a finished step to a concrete model + provider, and detect fallback. Under a fallback
 * chain the served model id (from the step's response) can differ from the primary; we reconcile
 * against the resolved chain — exact match first, then a prefix-tolerant match (handles dated
 * provider ids), else fall back to the primary entry. This keeps `llm_call` rows from recording the
 * joined `"a|b|c"` FallbackModel id. `fellBack` is true when a served id positively matched a
 * NON-primary chain entry — i.e. an earlier provider failed and the chain advanced.
 */
export function attributeModel(
  servedModelId: string | null,
  chain: ResolvedModelEntry[],
  primaryModelId: string
): { model: string; provider: string | null; fellBack: boolean; entry?: ResolvedModelEntry } {
  const model = servedModelId ?? primaryModelId;
  let idx = chain.findIndex((e) => e.modelId === model);
  if (idx < 0) {
    idx = chain.findIndex(
      (e) => model.startsWith(`${e.modelId}-`) || e.modelId.startsWith(`${model}-`)
    );
  }
  const entry = idx >= 0 ? chain[idx] : chain[0];
  // Only a positively-matched non-primary entry counts as a fallback (a missing served id is
  // ambiguous → assume primary). `entry` carries the pinned spec (pricing) for the served model.
  return {
    model,
    provider: entry?.provider ?? null,
    fellBack: servedModelId != null && idx > 0,
    entry,
  };
}
