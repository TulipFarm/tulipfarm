import {
  fetchLiteLlmCatalog,
  type LiteLlmCatalog,
  type LlmService,
  litellmModelsForProvider,
  resolveModelSpec,
  resolveModelSpecCandidate,
} from "@tulipfarm/llm";
import {
  deriveModelProfiles,
  type LlmConfig,
  LlmConfigValidationError,
  type TierConfig,
  validateLlmConfig,
} from "@tulipfarm/schema";
import { LLM_PROVIDERS, type SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { UserDoc } from "../../auth/users";
import { writeLlmConfigToSoulYaml } from "./soul-yaml-io";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

// In-memory LiteLLM catalog cache (the JSON is ~large; refetch at most hourly). Shared across
// resolve-spec calls so adding several models doesn't re-download each time.
const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalogCache: { at: number; catalog: LiteLlmCatalog | null } | null = null;

/** Test-only: clear the module-level catalog cache so each test controls its own stubbed catalog. */
export function __resetLlmCatalogCache(): void {
  catalogCache = null;
}

async function getCatalog(force = false): Promise<LiteLlmCatalog | null> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.catalog;
  }
  const catalog = await fetchLiteLlmCatalog();
  // Cache even a null (failed) result briefly so a flaky network doesn't hammer GitHub per keystroke
  // (a `force` refresh always re-fetches first, so a transient failure isn't sticky for the UI).
  if (catalog || !catalogCache) catalogCache = { at: Date.now(), catalog };
  return catalog;
}

// Returned by GET when soul.yaml has no `llm:` key yet, so the editor opens with empty tiers instead
// of erroring. Not itself schema-valid for PUT (tiers need ≥1 provider) — the user fills it in and saves.
const EMPTY_LLM_CONFIG = {
  tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
} as const;

const TIER_KEYS = ["quick", "standard", "complex"] as const;
const PRESET_KEYS = ["default", "fast", "balanced", "thorough"] as const;

const LIVE_MODELS_TIMEOUT_MS = 5000;

const ModelSpecRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    litellm_key: { type: "string" },
    input_cost_per_token: { type: "number", minimum: 0 },
    output_cost_per_token: { type: "number", minimum: 0 },
    cache_read_input_token_cost: { type: "number", minimum: 0 },
    cache_creation_input_token_cost: { type: "number", minimum: 0 },
    max_input_tokens: { type: "integer", minimum: 1 },
    max_output_tokens: { type: "integer", minimum: 1 },
    mode: { type: "string" },
    supports_function_calling: { type: "boolean" },
    supports_vision: { type: "boolean" },
    supports_prompt_caching: { type: "boolean" },
    supports_reasoning: { type: "boolean" },
    deprecation_date: { type: "string", nullable: true },
    fetched_at: { type: "string" },
  },
} as const;

const ProviderEntryRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    api_key_ref: { type: "string" },
    base_url: { type: "string" },
    resource_name: { type: "string" },
    spec: ModelSpecRouteSchema,
  },
} as const;

const TierConfigRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    providers: { type: "array", items: ProviderEntryRouteSchema },
  },
} as const;

const ProviderConnectionRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    provider: { type: "string" },
    api_key_ref: { type: "string" },
    base_url: { type: "string" },
    resource_name: { type: "string" },
  },
} as const;

const LlmConfigRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    connections: {
      type: "object",
      additionalProperties: ProviderConnectionRouteSchema,
    },
    tiers: {
      type: "object",
      additionalProperties: true,
      properties: {
        quick: TierConfigRouteSchema,
        standard: TierConfigRouteSchema,
        complex: TierConfigRouteSchema,
      },
    },
    presets: {
      type: "object",
      additionalProperties: true,
      properties: {
        default: { type: "string" },
        fast: { type: "string" },
        balanced: { type: "string" },
        thorough: { type: "string" },
      },
    },
    embeddings: {
      type: "object",
      additionalProperties: true,
      properties: {
        providers: { type: "array", items: ProviderEntryRouteSchema },
      },
    },
  },
} as const;

/**
 * For `openai-compatible` providers pointed at a self-hosted LiteLLM proxy, the static LiteLLM
 * catalog lists every model that ever existed rather than what the operator actually deployed.
 * Best-effort: any missing base_url, network error, non-200, or unparseable body returns null so
 * the caller falls back to the catalog (the field stays usable as free-text entry either way).
 */
async function fetchLiveModelOptions(
  secrets: SecretsService,
  log: { warn: (obj: unknown, msg?: string) => void }
): Promise<string[] | null> {
  let baseUrl: string;
  try {
    baseUrl = await secrets.get("openai-compatible-base-url");
  } catch {
    return null;
  }
  if (!baseUrl) return null;

  let apiKey: string | undefined;
  try {
    apiKey = await secrets.get("openai-compatible-api-key");
  } catch {
    apiKey = undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_MODELS_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const ids = body.data
      .map((m) => (m as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
    return ids;
  } catch (err) {
    log.warn({ err }, "live model fetch from openai-compatible proxy failed");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Auto-resolve + pin a LiteLLM spec onto every model that doesn't already have one, so that simply
 * adding a model and saving is enough for cost tracking (no per-model "Fetch spec" click). Best-effort:
 * if the catalog is unreachable, the config is saved unchanged; models with no LiteLLM match are left
 * spec-less (and show as "unpriced"). Existing specs are preserved — use the form's Refresh to update.
 * `force` re-resolves ALL models against a freshly-fetched catalog.
 */
async function enrichSpecs(config: LlmConfig, force: boolean): Promise<LlmConfig> {
  const tiers = config.tiers;
  if (!tiers) return config; // defensive for unchecked callers; validation requires chains
  const all = TIER_KEYS.flatMap((t) => tiers[t].providers);
  if (!force && all.every((p) => p.spec)) return config; // nothing missing → no fetch
  const catalog = await getCatalog(force);
  if (!catalog) return config; // can't reach LiteLLM → save as-is
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const enrichTier = (tier: TierConfig): TierConfig => ({
    ...tier,
    providers: tier.providers.map((p) => {
      if (p.spec && !force) return p;
      const { spec } = resolveModelSpec(p.provider, p.model, catalog, fetchedAt);
      return spec ? { ...p, spec } : p;
    }),
  });
  return {
    ...config,
    tiers: {
      quick: enrichTier(tiers.quick),
      standard: enrichTier(tiers.standard),
      complex: enrichTier(tiers.complex),
    },
  };
}

function validatePresetTargets(config: LlmConfig): string | null {
  if (!config.presets || !config.tiers) return null;
  const available = new Set(deriveModelProfiles(config).map((profile) => profile.profileId));
  for (const key of PRESET_KEYS) {
    const target = config.presets[key];
    if (target !== undefined && !available.has(target)) {
      return `preset ${key} points at unknown ModelProfile "${target}"`;
    }
  }
  return null;
}

function validateRoutingCapacity(config: LlmConfig): string | null {
  if (!config.tiers) return null;
  for (const tier of TIER_KEYS) {
    for (const entry of config.tiers[tier].providers) {
      const capacity = entry.spec?.max_input_tokens;
      if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity <= 0) {
        return (
          `${tier} model ${entry.provider}/${entry.model} needs a verified context window. ` +
          "Select a LiteLLM candidate or enter max input tokens in Settings before saving."
        );
      }
    }
  }
  return null;
}

/*
 * LLM config editing (UI-V1-003 / LLM-V1-003). Reads and full-replaces soul.yaml's `llm:` key.
 *
 * Write path safety (LLM-V1-003 AC4): the incoming config is validated with `validateLlmConfig`
 * BEFORE it is written, and `LlmService.init` re-validates and rebuilds before mutating its own
 * state, so a structurally invalid config is rejected (422) with the running service untouched.
 * `gitSync.withSync` does not emit `soul.synced`, so we reload + re-init the LlmService inline here.
 * Embeddings are round-tripped untouched by the structured form, so the EmbeddingService is not
 * re-initialised.
 */
export function registerLlmConfigRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  llmService: LlmService,
  secrets: SecretsService,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/llm-providers",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List the supported LLM providers (registry): id, label, canonical secret key, and required config fields. Drives the Settings provider dropdowns.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["providers"],
            properties: {
              providers: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => reply.send({ providers: LLM_PROVIDERS })
  );

  app.get(
    "/api/v1/provider-config",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Values of stored provider CONFIG fields (e.g. Azure resource_name, base_url). Secret fields (API keys) are never returned — only non-sensitive config so the UI can show it back.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["values"],
            properties: { values: { type: "object", additionalProperties: { type: "string" } } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const values: Record<string, string> = {};
      for (const provider of LLM_PROVIDERS) {
        for (const field of provider.fields) {
          if (field.kind !== "config") continue; // never read/return secret values
          try {
            values[field.key] = await secrets.get(field.key);
          } catch {
            // unset — skip
          }
        }
      }
      return reply.send({ values });
    }
  );

  app.get(
    "/api/v1/llm-config",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read the current LLM config. A fresh instance with no `llm:` key in soul.yaml gets an empty skeleton (three tiers, no providers) so the editor opens ready to configure.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: LlmConfigRouteSchema,
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const config = (soulLoader.llmConfig as LlmConfig | undefined) ?? EMPTY_LLM_CONFIG;
      return reply.send(config);
    }
  );

  app.get(
    "/api/v1/llm-config/resolve-spec",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Resolve a model's spec (pricing/context/capabilities) from LiteLLM for a given provider+model, to pin into llm.config. Admin only. `spec` is null when no confident match was found (use `candidates` and resubmit the selected `candidate`).",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          required: ["provider", "model"],
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            base_url: { type: "string" },
            refresh: { type: "boolean" },
            candidate: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["spec", "matchedKey", "candidates"],
            properties: {
              spec: { type: "object", additionalProperties: true, nullable: true },
              matchedKey: { type: "string", nullable: true },
              candidates: { type: "array", items: { type: "string" } },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const q = req.query as {
        provider: string;
        model: string;
        refresh?: boolean;
        candidate?: string;
      };
      const catalog = await getCatalog(q.refresh === true);
      if (!catalog) {
        return reply.code(502).send({ error: "could not reach the LiteLLM model catalog" });
      }
      const fetchedAt = new Date().toISOString().slice(0, 10);
      if (q.candidate) {
        const resolution = resolveModelSpecCandidate(q.candidate, catalog, fetchedAt);
        if (!resolution.spec) {
          return reply.code(422).send({
            error: "The selected LiteLLM candidate has no usable context-window specification.",
          });
        }
        return reply.send(resolution);
      }
      return reply.send(resolveModelSpec(q.provider, q.model, catalog, fetchedAt));
    }
  );

  app.get(
    "/api/v1/llm-config/model-options",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Suggested model ids for a provider, to populate the Settings model picker. Admin only. For `openai-compatible` with a configured base_url, `source: live` lists the proxy's actually-deployed models (via its `GET /models`); otherwise `source: catalog` lists known LiteLLM ids; `source: unavailable` (+ `reason`) means neither could be reached and the UI falls back to free-text entry.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["models", "source"],
            properties: {
              models: { type: "array", items: { type: "string" } },
              source: { type: "string", enum: ["catalog", "live", "unavailable"] },
              reason: { type: "string" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const { provider } = req.query as { provider: string };

      if (provider === "openai-compatible") {
        const live = await fetchLiveModelOptions(secrets, req.log);
        if (live) return reply.send({ models: live, source: "live" });
      }

      const catalog = await getCatalog();
      if (!catalog) {
        return reply.send({
          models: [],
          source: "unavailable",
          reason: "Couldn't reach the model catalog.",
        });
      }
      return reply.send({ models: litellmModelsForProvider(provider, catalog), source: "catalog" });
    }
  );

  app.put(
    "/api/v1/llm-config",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Replace the LLM config (admin only). Each model's spec (pricing/context/capabilities) is auto-resolved from LiteLLM and pinned; unresolved models require an explicit positive context window. `?refresh=true` re-resolves all. Validated before write; the soul is committed and the LlmService reloaded.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: { type: "object", properties: { refresh: { type: "boolean" } } },
        body: LlmConfigRouteSchema,
        response: {
          200: LlmConfigRouteSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }

      let config: LlmConfig;
      try {
        config = validateLlmConfig(req.body);
      } catch (err) {
        if (err instanceof LlmConfigValidationError) {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
      const presetProblem = validatePresetTargets(config);
      if (presetProblem) {
        return reply.code(422).send({ error: presetProblem });
      }

      // Auto-pin specs for any model missing one (or all, with ?refresh=true) so cost tracking works
      // without a per-model click. Best-effort — a LiteLLM outage saves the config unchanged.
      const { refresh } = req.query as { refresh?: boolean };
      config = await enrichSpecs(config, refresh === true);
      const capacityProblem = validateRoutingCapacity(config);
      if (capacityProblem) {
        return reply.code(422).send({ error: capacityProblem });
      }

      await writeLlmConfigToSoulYaml(gitSync.path, config);
      await gitSync.withSync("soul: update llm config");
      await soulLoader.reload();
      await llmService.init(soulLoader.llmConfig, secrets, app.log);

      return reply.send(soulLoader.llmConfig);
    }
  );
}
