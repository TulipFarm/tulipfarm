import { createHash } from "node:crypto";
import type { LlmService } from "@tulipfarm/llm";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { generateObject, jsonSchema } from "ai";
import type { FastifyBaseLogger } from "fastify";
import type { KvService } from "../kv/service";
import type { Suggestion } from "./suggestions";

/*
 * LLM personalization for the onboarding surface (ONBOARDING ONB-V1, issue #130). When the soul
 * carries a `businessDescription`, a single quick-tier LLM call produces suggestion chips + checklist
 * recommendations tailored to the business AND the current soul state (existing resource/agent/skill
 * names) — so e.g. a `tickets` resource yields a "create an agent for tickets" recommendation.
 *
 * The result is cached in the system-scoped KV store keyed by a hash of (businessDescription + sorted
 * soul names), so it regenerates only when that state changes — one LLM call per distinct state. When
 * no businessDescription / no LLM / no KV is available, or the call fails, the orchestrator returns
 * null and the routes fall back to the static CATALOG + RULES (behavior identical to before).
 */

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
  "Never propose something that already exists in the soul. Be specific to the business domain.",
].join("\n");

const validatePersonalized = ajv.compile(PERSONALIZED_SCHEMA);

type LlmModel = ReturnType<LlmService["select"]>;

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

/** Stable KV key: sha256 of (businessDescription + sorted soul names). Changes iff the state does. */
export function buildStateKey(businessDescription: string, state: SoulState): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ d: businessDescription, ...state }))
    .digest("hex");
  return `suggestions:${hash}`;
}

/** Run the LLM call and return a validated {@link Personalized}. Throws on malformed output. */
export async function generatePersonalized(
  model: LlmModel,
  ctx: { businessName?: string; businessDescription: string; state: SoulState }
): Promise<Personalized> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<Personalized>(PERSONALIZED_SCHEMA),
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

function stringField(manifest: Record<string, unknown> | null, key: string): string | undefined {
  const v = manifest?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Orchestrator used by both onboarding routes. Returns the personalized surfaces, or `null` when
 * personalization is unavailable (no businessDescription / no LLM / no KV) or the LLM call fails —
 * in which case the caller falls back to the static catalog + rules. Never throws.
 */
export async function getPersonalizedOnboarding(
  soul: PersonalizeSoulSlice,
  deps: PersonalizeDeps
): Promise<Personalized | null> {
  const businessDescription = stringField(soul.manifest, "businessDescription");
  const { llmService, kvService, logger } = deps;
  if (!businessDescription || !llmService || !kvService) return null;

  const state = readSoulState(soul);
  const key = buildStateKey(businessDescription, state);

  const cached = await kvService.get("system", undefined, KV_NAMESPACE, key);
  if (cached) return cached.value as Personalized;

  try {
    const result = await generatePersonalized(llmService.select({ model: "quick" }), {
      businessName: stringField(soul.manifest, "businessName"),
      businessDescription,
      state,
    });
    await kvService.set("system", undefined, KV_NAMESPACE, key, result);
    return result;
  } catch (err) {
    logger?.error({ err }, "onboarding personalization failed; falling back to static catalog");
    return null;
  }
}
