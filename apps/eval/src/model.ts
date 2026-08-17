import {
  ModelInvocationError,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelPort,
  type ModelUsage,
} from "@tulipfarm/agent-runtime";
import {
  type CostBasis,
  classifyProviderError,
  decidePromptCache,
  priceCall,
} from "@tulipfarm/llm";
import {
  splitPrompt,
  stablePrefixChars,
  toOutput,
  toToolSet,
  UsageAccumulator,
  withCacheBreakpoint,
} from "@tulipfarm/model-adapter";
import type { EffortRung, ProviderEntry } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { type LanguageModel, streamText } from "ai";
import type { EvalCase } from "./case.ts";
import type { ModelBinding } from "./runner.ts";

/**
 * One vendor model a Sweep may be run against.
 *
 * Everything a comparison must hold constant lives here. A Sweep names one of these and nothing
 * else decides which model answers: there is no Model Profile, no tier and no Effort classifier
 * between the Corpus and the provider.
 */
export interface PinnedModel {
  /** Recorded in the Scorecard; a comparison across different ids is not a comparison. */
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  /**
   * The environment variable holding this seat's credential.
   *
   * A variable reference, never a value: the provider layer resolves `env://` itself and throws
   * when it is unset, so an absent credential stops the Sweep instead of quietly leaving some
   * other credential to answer for it.
   */
  readonly credentialEnv: string;
  /** What to run to obtain that credential, printed when it is missing. */
  readonly credentialHint: string;
  /**
   * Whether `model` is a dated identifier the vendor cannot move.
   *
   * `false` for the subscription CLIs, whose ids are aliases (`sonnet`, `gpt-5.6-luna`). A Sweep
   * against an alias cannot prove the model did not change under it, so the Scorecard says so
   * rather than implying a rigour it does not have.
   */
  readonly dated: boolean;
  /**
   * Pinned rather than inferred. In production the Effort classifier picks a rung from the
   * prompt; letting it run here would mean a classifier change silently altered what every Case
   * measures, and the regression would be attributed to the harness.
   */
  readonly effort: EffortRung;
  /**
   * Environment variables that would silently redirect this seat somewhere else.
   *
   * The vendor CLIs run in a jail that passes a short allowlist through, and that allowlist
   * includes a base-URL override. A Sweep that measured a proxy instead of the vendor would read
   * as a harness result, and nothing on the Scorecard could reveal it.
   */
  readonly forbiddenEnv: readonly string[];
  /**
   * The shape the credential must already have, checked before the first Trial.
   *
   * Declared rather than supplied as a function so `PINNED_MODELS` stays data, and so the provider
   * SDK that knows the shape is still only imported when a real model is actually selected.
   */
  readonly credentialShape?: "codex-auth-json";
}

/**
 * The models a release Sweep may use.
 *
 * Two vendors, because a single vendor's Scorecard cannot distinguish a harness improvement from
 * that vendor's own drift.
 *
 * Both are subscription seats driven through their vendor CLI, which is how this deployment
 * reaches a model at all. That has two consequences the Scorecard must not paper over: a seat has
 * a genuine zero marginal cost, so dollars cannot bound a Sweep and tokens must; and neither
 * vendor publishes a dated id for a seat, so `dated` is false and the pin is only as stable as
 * the alias.
 */
export const PINNED_MODELS = {
  sonnet: {
    id: "sonnet",
    provider: "claude-code",
    model: "sonnet",
    credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    credentialHint: "claude setup-token",
    dated: false,
    effort: "balanced",
    forbiddenEnv: ["ANTHROPIC_BASE_URL"],
  },
  luna: {
    id: "luna",
    provider: "codex",
    model: "gpt-5.6-luna",
    credentialEnv: "CODEX_AUTH_JSON",
    credentialHint: 'codex login, then: export CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"',
    dated: false,
    effort: "balanced",
    forbiddenEnv: ["OPENAI_BASE_URL"],
    credentialShape: "codex-auth-json",
  },
} as const satisfies Record<string, PinnedModel>;

export type PinnedModelName = keyof typeof PINNED_MODELS;

export function isPinnedModelName(value: string): value is PinnedModelName {
  return Object.hasOwn(PINNED_MODELS, value);
}

/** The provider-layer entry point, injectable so the conversion can be tested without a vendor. */
export type CreateModelFn = (
  entry: ProviderEntry,
  secrets: SecretsService,
  options?: { timeoutMs?: number }
) => Promise<LanguageModel>;

export interface PinnedBindingOptions {
  readonly timeoutMs?: number;
  readonly createModel?: CreateModelFn;
}

export interface PinnedBinding extends ModelBinding {
  readonly model: string;
  readonly effort: EffortRung;
  readonly dated: boolean;
  /** The version the API reported, once a call has been answered. */
  reportedVersion(): string | undefined;
}

/**
 * Builds the provider entry for a pinned model.
 *
 * The key is referenced, never inlined: `env://` is resolved by the provider layer against the
 * process environment and throws when unset, so an absent credential stops the Sweep instead of
 * quietly leaving the deployment's shared key to answer for it.
 */
export function providerEntry(pinned: PinnedModel): ProviderEntry {
  return {
    provider: pinned.provider,
    model: pinned.model,
    api_key_ref: `env://${pinned.credentialEnv}`,
  };
}

/**
 * A `SecretsService` that cannot be reached.
 *
 * `providerEntry` always uses an `env://` reference, which the provider layer resolves without
 * consulting stored secrets. Throwing here makes that an executable guarantee: if the reference
 * ever changes shape, the Sweep stops rather than silently reading a stored deployment key and
 * measuring the wrong account.
 */
function unreachableSecrets(): SecretsService {
  const guard = {
    get: (): never => {
      throw new Error("eval must resolve its key from the environment, not from stored secrets");
    },
  };
  return guard as unknown as SecretsService;
}

/**
 * A binding that runs every Case against one directly-constructed vendor model.
 *
 * The router, the Model Profile catalogue and the Effort classifier are all bypassed: the loop is
 * handed a port wrapping a single model, so no selection logic sits between a Corpus change and
 * the Scorecard. What it keeps is the production conversion — the same prompt splitting, tool
 * shaping and usage accounting the Worker uses — because a second copy of that would let the eval
 * score a call the product would never make.
 */
export function pinnedBinding(
  pinned: PinnedModel,
  options: PinnedBindingOptions = {}
): PinnedBinding {
  const create = options.createModel ?? defaultCreateModel;
  let reported: string | undefined;
  // Built once per Sweep, not per Case: the client is stateless, and rebuilding it would pay the
  // provider handshake on every Case for no gain.
  let client: Promise<LanguageModel> | undefined;

  const preflight = async (): Promise<void> => {
    assertNotRedirected(pinned);
    const raw = process.env[pinned.credentialEnv];
    if (raw === undefined || raw.trim() === "") {
      throw new Error(
        `${pinned.credentialEnv} is not set. Get the credential with: ${pinned.credentialHint}`
      );
    }
    if (pinned.credentialShape === "codex-auth-json") {
      const { parseCodexAuth } = await import("@tulipfarm/llm");
      try {
        parseCodexAuth(raw);
      } catch (error) {
        // Named so the reader knows which variable to fix, and so `withCredentialHint` recognises
        // the failure and appends the command that produces a good one.
        const why = error instanceof Error ? error.message : String(error);
        throw withCredentialHint(new Error(`${pinned.credentialEnv} is malformed: ${why}`), pinned);
      }
    }
  };

  const model = async (): Promise<LanguageModel> => {
    assertNotRedirected(pinned);
    client ??= create(
      providerEntry(pinned),
      unreachableSecrets(),
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
    );
    try {
      return await client;
    } catch (error) {
      // Cleared so a later Case retries the build; the message is otherwise memoised as a
      // rejected promise and every Case reports the same stale failure.
      client = undefined;
      throw withCredentialHint(error, pinned);
    }
  };

  return {
    id: pinned.id,
    model: pinned.model,
    effort: pinned.effort,
    dated: pinned.dated,
    reportedVersion: () => reported,
    preflight,
    create: (_evalCase: EvalCase): ModelPort => ({
      invoke: async (request) =>
        invokeOnce(await model(), pinned, request, (version) => {
          reported = version;
        }),
    }),
  };
}

export async function defaultCreateModel(
  entry: ProviderEntry,
  secrets: SecretsService,
  options?: { timeoutMs?: number }
): Promise<LanguageModel> {
  // Imported lazily so the scripted tier never loads the provider SDKs, and so a missing
  // credential is reported by the call that needed it rather than at module load.
  const { createModel } = await import("@tulipfarm/llm");
  // Deliberately no `principal` and no `credentials`. The provider layer prefers a principal's
  // own key when both are supplied and reports nothing when it does, so a Sweep could silently
  // measure a different account. Passing neither makes that path unreachable.
  return createModel(entry, secrets, options ?? {});
}

/**
 * Refuses to run when the environment could point the seat at something other than the vendor.
 *
 * Requirement, not hygiene: a Sweep exists to attribute a change to the harness. One measured
 * against a proxy or a self-hosted endpoint attributes it to the wrong thing, and the Scorecard
 * has no field that could say so. The vendor CLIs pass a base-URL override through their jail.
 */
function assertNotRedirected(pinned: PinnedModel): void {
  for (const name of pinned.forbiddenEnv) {
    if (process.env[name]) {
      throw new Error(
        `${name} is set — it would silently redirect the ${pinned.provider} seat away from the ` +
          `vendor, and the Scorecard could not show it. Unset it before running a Sweep.`
      );
    }
  }
}

/**
 * Turns the provider layer's bare "env var not set" into something actionable.
 *
 * Deliberately not chained with `cause`: the loop reports the *deepest* message it can find, so a
 * wrapper that kept the original would be thrown away and the operator would see only the bare
 * variable name again. The original message is subsumed here, so nothing is lost.
 */
function withCredentialHint(error: unknown, pinned: PinnedModel): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(pinned.credentialEnv)) return error;
  return new Error(
    `${message} — this Sweep runs on the ${pinned.provider} seat. ` +
      `Get the credential with: ${pinned.credentialHint}`
  );
}

/** Flattens a `CostBasis` into the `ModelUsage` fields, keeping `costUsd` absent when unknown. */
function basis(cost: CostBasis): Pick<ModelUsage, "costUsd" | "costBasis"> {
  return {
    ...(cost.kind === "priced" ? { costUsd: cost.costUsd } : {}),
    costBasis: cost.kind,
  };
}

async function invokeOnce(
  model: LanguageModel,
  pinned: PinnedModel,
  request: ModelInvocationRequest,
  onVersion: (version: string) => void
): Promise<ModelInvocationResult> {
  const { instructions, messages } = splitPrompt(request.messages);
  const prompt = withCacheBreakpoint(
    instructions,
    decidePromptCache({
      provider: pinned.provider,
      modelId: pinned.model,
      cacheAllowed: true,
      prefixChars: stablePrefixChars(instructions, request.tools),
    })
  );

  // Accumulated per step rather than read from the terminal chunk: a call that dies mid-stream
  // never reaches that chunk, and the vendor still bills for what it did. A Sweep that under-
  // reported its own failures would understate the cost of the runs it most needs to explain.
  const observed = new UsageAccumulator();
  const price = (tokensIn: number, tokensOut: number) =>
    priceCall({ provider: pinned.provider, modelId: pinned.model, tokensIn, tokensOut });

  try {
    const result = streamText({
      model,
      messages,
      ...(prompt.length === 0 ? {} : { instructions: prompt }),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: toToolSet(request.tools) }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      // The SDK retries transient failures itself, silently and unbounded by anything the Sweep
      // can see. A Sweep has to report a retry as a retry — and count what each attempt cost —
      // so the retry policy is owned above this call instead.
      maxRetries: 0,
    });

    let streamError: Error | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        // Not thrown on sight: the step's usage arrives in the `finish-step` part that follows,
        // and bailing out here is what makes a mid-stream failure look free.
        streamError = part.error instanceof Error ? part.error : new Error(String(part.error));
        continue;
      }
      if (part.type === "finish-step") observed.add(part.usage);
    }
    if (streamError !== undefined) throw streamError;

    const [calls, text, usage] = await Promise.all([result.toolCalls, result.text, result.usage]);
    const settled = observed.settle(price);
    // Only a *reported* version is worth recording. The SDK seeds the response id from the id we
    // asked for, so a provider that never emits `response-metadata` — which both vendor CLIs do
    // not — would otherwise have its echo rendered as confirmation. Printing `version=sonnet`
    // beside `model=sonnet` asserts the vendor confirmed something it never said, on exactly the
    // aliased models where a silent roll-forward is the confound worth catching.
    const responseModelId = (await result.response).modelId;
    if (responseModelId !== undefined && responseModelId !== pinned.model) {
      onVersion(responseModelId);
    }

    return {
      requestId: request.requestId,
      output: toOutput(calls, text),
      // Priced through the same authority as the settled path. Hardcoding `unpriced` here would
      // report a seat's zero marginal cost as an unknown one, which is the collapse the spend
      // ledger exists to prevent.
      usage: settled ?? {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...basis(price(usage.inputTokens ?? 0, usage.outputTokens ?? 0)),
      },
    };
  } catch (error) {
    const partial = observed.settle(price);
    throw error instanceof ModelInvocationError
      ? new ModelInvocationError(error.reason, error.cause, partial)
      : new ModelInvocationError(classifyProviderError(error), error, partial);
  }
}
