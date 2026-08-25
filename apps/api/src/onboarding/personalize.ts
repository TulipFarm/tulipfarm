import { createHash } from "node:crypto";
import {
  generatePersonalized,
  type OnboardingSoulState,
  type Personalized,
} from "@tulipfarm/built-in-agents";
import type { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyBaseLogger } from "fastify";

/*
 * Caching around the `onboarding_personalizer` BuiltInAgent.
 *
 * The prompt, the output schema and the model call live in `@tulipfarm/built-in-agents`. What
 * stays here is what this app owns: the KV cache keyed on business description plus soul state,
 * the in-flight de-duplication, and the rule that no request ever waits on the model.
 */

const KV_NAMESPACE = "onboarding";

/** The soul slice this module reads for the LLM context + cache key. */
export type PersonalizeSoulSlice = Pick<SoulLoader, "resources" | "agents" | "skills" | "manifest">;

export interface PersonalizeDeps {
  llmService?: LlmService;
  kvService?: KvService;
  logger?: FastifyBaseLogger;
}

function readSoulState(soul: PersonalizeSoulSlice): OnboardingSoulState {
  return {
    resources: [...soul.resources.keys()].sort(),
    agents: [...soul.agents.keys()].sort(),
    skills: [...soul.skills.keys()].sort(),
  };
}

/** Stable KV key: sha256 of business description plus sorted soul names. */
export function buildStateKey(businessDescription: string, state: OnboardingSoulState): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ d: businessDescription, ...state }))
    .digest("hex");
  return `suggestions:${hash}`;
}

function stringField(manifest: Record<string, unknown> | null, key: string): string | undefined {
  const v = manifest?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Everything a personalization lookup needs, or null when personalization is not configured. */
function resolveRequest(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): { key: string; businessDescription: string; state: OnboardingSoulState } | null {
  const businessDescription = stringField(soul.manifest, "businessDescription");
  if (!businessDescription || !deps.llmService || !deps.kvService) return null;

  const state = readSoulState(soul);
  return { key: buildStateKey(businessDescription, state), businessDescription, state };
}

/*
 * In-flight refreshes keyed by state hash. Both onboarding routes are on the chat landing path and
 * the app polls, so without this a cold cache would fan a burst of identical LLM calls out of a
 * single page load.
 */
const refreshesInFlight = new Map<string, Promise<void>>();

/**
 * Reads personalized onboarding from the KV cache. Never calls the LLM, so it is safe to await on a
 * request that blocks first paint. Returns null on a miss — callers fall back to static
 * catalog/rules and should kick off {@link refreshPersonalizedOnboarding}.
 */
export async function readPersonalizedOnboarding(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): Promise<Personalized | null> {
  const req = resolveRequest(soul, deps);
  if (!req || !deps.kvService) return null;

  const cached = await deps.kvService.get("system", undefined, KV_NAMESPACE, req.key);
  return cached ? (cached.value as Personalized) : null;
}

/**
 * Generates personalization and writes it to the KV cache so a later request can read it. This makes
 * an LLM call, so callers must NOT await it on a request path — fire and forget. Concurrent calls
 * for the same soul state share one refresh. Never rejects; failures are logged and swallowed.
 *
 * The returned promise is for tests and shutdown coordination only.
 */
export function refreshPersonalizedOnboarding(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): Promise<void> {
  const req = resolveRequest(soul, deps);
  const { llmService, kvService, logger } = deps;
  if (!req || !llmService || !kvService) return Promise.resolve();

  const existing = refreshesInFlight.get(req.key);
  if (existing) return existing;

  const run = (async () => {
    try {
      const result = await generatePersonalized(llmService.effortModel("fast"), {
        businessName: stringField(soul.manifest, "businessName"),
        businessDescription: req.businessDescription,
        state: req.state,
      });
      await kvService.set("system", undefined, KV_NAMESPACE, req.key, result);
    } catch (err) {
      logger?.error({ err }, "onboarding personalization failed; falling back to static catalog");
    } finally {
      refreshesInFlight.delete(req.key);
    }
  })();

  refreshesInFlight.set(req.key, run);
  return run;
}

/**
 * The request-path entry point both onboarding routes use: return the cached personalization if one
 * exists, otherwise start a background refresh and return null so the caller falls back to the
 * static catalog. Never waits on the LLM.
 */
export async function getPersonalizedOrRefresh(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): Promise<Personalized | null> {
  const cached = await readPersonalizedOnboarding(soul, deps);
  if (cached) return cached;
  void refreshPersonalizedOnboarding(soul, deps);
  return null;
}
