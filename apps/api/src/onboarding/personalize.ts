import { createHash } from "node:crypto";
import type { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { generateObject, jsonSchema } from "ai";
import type { FastifyBaseLogger } from "fastify";
import type { Suggestion } from "./suggestions";

/* Caches one quick-tier LLM personalization per business-description plus soul-name hash. */

const KV_NAMESPACE = "onboarding";

/** LLM output: both onboarding surfaces in one shot. Shapes match the static `Suggestion`. */
export interface Personalized {
  suggestions: Suggestion[];
  recommendations: Suggestion[];
}

/** The soul slice this module reads for the LLM context + cache key. */
export type PersonalizeSoulSlice = Pick<SoulLoader, "resources" | "agents" | "skills" | "manifest">;

export interface PersonalizeDeps {
  llmService?: LlmService;
  kvService?: KvService;
  logger?: FastifyBaseLogger;
}

// Plain JSON Schema (TypeBox is not importable in apps/api). Fed to AJV for post-validation and to
// the AI SDK's `jsonSchema()` to constrain the model's structured output.
const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "prompt"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    prompt: { type: "string" },
  },
} as const;

export const PERSONALIZED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions", "recommendations"],
  properties: {
    suggestions: { type: "array", items: ITEM_SCHEMA },
    recommendations: { type: "array", items: ITEM_SCHEMA },
  },
} as const;

export const SYSTEM_PROMPT = [
  "You are TulipFarm's onboarding guide for an AI-native business",
  "operating system. Given a business and what it has already built in its soul, propose the most",
  "useful next things to create.",
  "",
  "Return two lists:",
  "- `suggestions`: 3-4 empty-state starter chips — the resource types / building blocks this",
  "  business should set up first.",
  "- `recommendations`: 2-3 contextual next steps given what ALREADY exists (e.g. an agent to",
  "  manage an existing resource, a skill to extend an existing agent, knowledge to ground it).",
  "",
  "For every item:",
  '- `id`: short kebab-case slug (e.g. "tickets", "agent-for-tickets").',
  '- `label`: short chip text, question style (e.g. "Set up ticket management?").',
  '- `prompt`: the chat message that seeds the build flow (e.g. "Help me set up ticket management.").',
  "",
  "Return raw JSON only. Do not wrap the response in Markdown or a code fence.",
  "Never propose something that already exists in the soul. Be specific to the business domain.",
].join("\n");

const validatePersonalized = ajv.compile(PERSONALIZED_SCHEMA);

type LlmModel = ReturnType<LlmService["effortModel"]>;

interface SoulState {
  resources: string[];
  agents: string[];
  skills: string[];
}

function readSoulState(soul: PersonalizeSoulSlice): SoulState {
  return {
    resources: [...soul.resources.keys()].sort(),
    agents: [...soul.agents.keys()].sort(),
    skills: [...soul.skills.keys()].sort(),
  };
}

/** Stable KV key: sha256 of business description plus sorted soul names. */
export function buildStateKey(businessDescription: string, state: SoulState): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ d: businessDescription, ...state }))
    .digest("hex");
  return `suggestions:${hash}`;
}

async function repairFencedJson({ text }: { text: string }): Promise<string | null> {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** Run the LLM call and return a validated {@link Personalized}. Throws on malformed output. */
export async function generatePersonalized(
  model: LlmModel,
  ctx: { businessName?: string; businessDescription: string; state: SoulState }
): Promise<Personalized> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<Personalized>(PERSONALIZED_SCHEMA),
    experimental_repairText: repairFencedJson,
    system: SYSTEM_PROMPT,
    prompt: [
      `Business name: ${ctx.businessName ?? "(unnamed)"}`,
      `Business description: ${ctx.businessDescription}`,
      "",
      "Already in the soul:",
      `- resource types: ${ctx.state.resources.join(", ") || "(none)"}`,
      `- agents: ${ctx.state.agents.join(", ") || "(none)"}`,
      `- skills: ${ctx.state.skills.join(", ") || "(none)"}`,
    ].join("\n"),
  });

  if (!validatePersonalized(object)) {
    throw new Error(
      `Onboarding personalization produced invalid output: ${ajv.errorsText(validatePersonalized.errors)}`
    );
  }
  return object;
}

/* Tier 3 profile-gap quests: the same business context, one more question — what would help us
   round out the business or user profile that a starter-chip suggestion would not ask. Cached
   under its own key so a personalization failure here never invalidates `suggestions`. */

const PROFILE_GAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gaps"],
  properties: { gaps: { type: "array", items: ITEM_SCHEMA } },
} as const;

const PROFILE_GAP_SYSTEM_PROMPT = [
  "You are TulipFarm's onboarding guide. Given a business and what it has already built, propose",
  "2-4 profile questions worth asking now: gaps in the BUSINESS profile (employee count,",
  "industry, website, operating hours) or gaps in what we know about THIS USER (preferred",
  "language, timezone, role). Never re-ask for the business name or description — both are",
  "already known.",
  "",
  "For every item: `id` short kebab-case slug, `label` short chip text (question style), and",
  '`prompt` the chat message that starts the conversation for it (e.g. "What are your typical',
  'operating hours?").',
  "",
  "Return raw JSON only. Do not wrap the response in Markdown or a code fence.",
].join("\n");

const validateProfileGaps = ajv.compile(PROFILE_GAP_SCHEMA);

/** Deterministic fallback when there is no provider key yet or the LLM call fails. */
export const STATIC_PROFILE_GAPS: Suggestion[] = [
  {
    id: "employee-count",
    label: "How many people work here?",
    prompt: "Help me record how many employees the business has.",
  },
  {
    id: "preferred-language",
    label: "What language should I use with you?",
    prompt: "Help me set my preferred language.",
  },
];

export async function generateProfileGaps(
  model: LlmModel,
  ctx: { businessName?: string; businessDescription: string; state: SoulState }
): Promise<Suggestion[]> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<{ gaps: Suggestion[] }>(PROFILE_GAP_SCHEMA),
    experimental_repairText: repairFencedJson,
    system: PROFILE_GAP_SYSTEM_PROMPT,
    prompt: [
      `Business name: ${ctx.businessName ?? "(unnamed)"}`,
      `Business description: ${ctx.businessDescription}`,
      "",
      "Already in the soul:",
      `- resource types: ${ctx.state.resources.join(", ") || "(none)"}`,
      `- agents: ${ctx.state.agents.join(", ") || "(none)"}`,
      `- skills: ${ctx.state.skills.join(", ") || "(none)"}`,
    ].join("\n"),
  });
  if (!validateProfileGaps(object)) {
    throw new Error(
      `Onboarding profile-gap generation produced invalid output: ${ajv.errorsText(validateProfileGaps.errors)}`
    );
  }
  return object.gaps;
}

/** Returns tier-3 profile-gap quests, or the static fallback when personalization is unavailable. */
export async function getProfileGaps(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): Promise<Suggestion[]> {
  const businessDescription = stringField(soul.manifest, "businessDescription");
  const { llmService, kvService, logger } = deps;
  if (!businessDescription || !llmService || !kvService) return STATIC_PROFILE_GAPS;

  const state = readSoulState(soul);
  const key = `profile-gaps:${buildStateKey(businessDescription, state).slice("suggestions:".length)}`;
  const cached = await kvService.get("system", undefined, KV_NAMESPACE, key);
  if (cached) return cached.value as Suggestion[];

  try {
    const gaps = await generateProfileGaps(llmService.effortModel("fast"), {
      businessName: stringField(soul.manifest, "businessName"),
      businessDescription,
      state,
    });
    await kvService.set("system", undefined, KV_NAMESPACE, key, gaps);
    return gaps;
  } catch (err) {
    logger?.error({ err }, "onboarding profile-gap generation failed; using static fallback");
    return STATIC_PROFILE_GAPS;
  }
}

function stringField(manifest: Record<string, unknown> | null, key: string): string | undefined {
  const v = manifest?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Everything a personalization lookup needs, or null when personalization is not configured. */
function resolveRequest(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): { key: string; businessDescription: string; state: SoulState } | null {
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
