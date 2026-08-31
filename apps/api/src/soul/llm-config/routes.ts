import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  checkEmbeddingReachability,
  checkModelReachability,
  cliModelIds,
  cliModelSpec,
  createEmbeddingModel,
  createModel,
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
  ModelSpecSchema,
  type TierConfig,
  validateLlmConfig,
} from "@tulipfarm/schema";
import { LLM_PROVIDERS, type SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { isSoulWriteError, mergeLlmConfigIntoSoulYaml, soulWriteHttpError } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditService } from "../../audit/service";
import { makeSoulAuditWriter } from "../../audit/soul-write";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import { commitActorFromRequest } from "../commit-actor";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Provider ids, model ids, tier structure and `api_key_ref` names describe where the business's
 * prompts are sent and on whose account, so reading them is an operator surface, not a member one.
 */
const LLM_CONFIG_READ = {
  action: "llm_config.read",
  resourceType: "llm_config",
  fallback: "admin",
} as const;

const LLM_CONFIG_RESOLVE = {
  action: "llm_config.resolve",
  resourceType: "llm_config",
  fallback: "admin",
} as const;

const LLM_CONFIG_WRITE = {
  action: "llm_config.write",
  resourceType: "llm_config",
  fallback: "admin",
} as const;

// In-memory LiteLLM catalog cache (the JSON is ~large; refetch at most hourly). Shared across
// resolve-spec calls so adding several models doesn't re-download each time.
const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalogCache: { at: number; catalog: LiteLlmCatalog | null } | null = null;

/** Test-only: clears module-level catalog cache so each test controls its stubbed catalog. */
export function __resetLlmCatalogCache(): void {
  catalogCache = null;
}

async function getCatalog(force = false): Promise<LiteLlmCatalog | null> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.catalog;
  }
  const catalog = await fetchLiteLlmCatalog();
  // Cache null failures briefly so a flaky network does not hammer GitHub per keystroke.
  // (a `force` refresh always re-fetches first, so a transient failure isn't sticky for the UI).
  if (catalog || !catalogCache) catalogCache = { at: Date.now(), catalog };
  return catalog;
}

// Returned by GET when soul.yaml has no `llm:` key, so the editor opens empty instead of
// erroring. Not schema-valid for PUT; the user fills tiers in and saves.
const EMPTY_LLM_CONFIG = {
  tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
} as const;

const TIER_KEYS = ["quick", "standard", "complex"] as const;
const PRESET_KEYS = ["default", "fast", "balanced", "thorough"] as const;

const LIVE_MODELS_TIMEOUT_MS = 5000;

const ProviderEntryRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    api_key_ref: { type: "string" },
    base_url: { type: "string" },
    resource_name: { type: "string" },
    spec: ModelSpecSchema,
  },
} as const;

const EmbeddingEntryRouteSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ...ProviderEntryRouteSchema.properties,
    dimension: { type: "integer", minimum: 1 },
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
        providers: { type: "array", items: EmbeddingEntryRouteSchema },
      },
    },
  },
} as const;

/** Best-effort live LiteLLM model fetch; failure falls back to catalog/free text. */
async function fetchLiveModelOptions(
  secrets: SecretsService,
  log: { warn: (obj: unknown, msg?: string) => void }
): Promise<string[] | null> {
  let baseUrl: string;
  try {
    baseUrl = await secrets.get("openai-compatible-base-url");
  } catch {
    // No stored base URL resolves to null; the probe reports unconfigured.
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

/** Pins LiteLLM specs best-effort; `force` re-resolves existing specs. */
async function enrichSpecs(config: LlmConfig, force: boolean): Promise<LlmConfig> {
  const tiers = config.tiers;
  if (!tiers) return config; // defensive for unchecked callers; validation requires chains
  const all = TIER_KEYS.flatMap((t) => tiers[t].providers);
  if (!force && all.every((p) => p.spec)) return config; // nothing missing → no fetch
  // CLI providers (e.g. claude-code) run on a subscription, not an API key, so they never resolve
  // against the LiteLLM catalog — no pricing exists for a subscription turn. Their spec comes from
  // a static local table instead; validateRoutingCapacity still requires *some* spec.
  const catalog = await getCatalog(force);
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const enrichTier = (tier: TierConfig): TierConfig => ({
    ...tier,
    providers: tier.providers.map((p) => {
      if (p.spec && !force) return p;
      const cliSpec = cliModelSpec(p.provider, p.model);
      if (cliSpec) return { ...p, spec: cliSpec };
      if (!catalog) return p; // can't reach LiteLLM → leave unresolved, save as-is
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

/* Validate before writing LLM config; inline re-init because the gateway reloads the Soul catalog
 * but knows nothing about `LlmService`. */
export function registerLlmConfigRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  llmService: LlmService,
  secrets: SecretsService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  // Optional: record LLM config changes as audit evidence. Which model answers, and under whose
  // key, decides both cost and where the business's prompts are sent.
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
  app.get(
    "/api/v1/llm-providers",
    {
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_READ)],
      schema: {
        description:
          "List the supported LLM providers (registry): id, label, canonical secret key, and required config fields. Drives the Settings provider dropdowns. Admin only.",
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
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => reply.send({ providers: LLM_PROVIDERS })
  );

  app.get(
    "/api/v1/provider-config",
    {
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_READ)],
      schema: {
        description:
          "Values of stored provider CONFIG fields (e.g. Azure resource_name, base_url). Secret fields (API keys) are never returned — only non-sensitive config so the UI can show it back. Admin only.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["values"],
            properties: { values: { type: "object", additionalProperties: { type: "string" } } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
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
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_READ)],
      schema: {
        description:
          "Read the current LLM config. Admin only. A fresh instance with no `llm:` key in soul.yaml gets an empty skeleton (three tiers, no providers) so the editor opens ready to configure.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: LlmConfigRouteSchema,
          401: ErrorSchema,
          403: ErrorSchema,
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
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_RESOLVE)],
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
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_RESOLVE)],
      schema: {
        description:
          "Suggested model ids for a provider, to populate the Settings model picker. Admin only. `mode` selects which catalog class to suggest (`chat`, the default, or `embedding`). For `openai-compatible` with a configured base_url, `source: live` lists the proxy's actually-deployed models (via its `GET /models`); otherwise `source: catalog` lists known LiteLLM ids; `source: unavailable` (+ `reason`) means neither could be reached and the UI falls back to free-text entry.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string" },
            mode: { type: "string", enum: ["chat", "embedding"], default: "chat" },
          },
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
      const { provider, mode = "chat" } = req.query as {
        provider: string;
        mode?: "chat" | "embedding";
      };

      if (provider === "openai-compatible") {
        const live = await fetchLiveModelOptions(secrets, req.log);
        if (live) return reply.send({ models: live, source: "live" });
      }

      // CLI providers (e.g. claude-code) never appear in the LiteLLM catalog — their model ids
      // come from the same static table `enrichSpecs` uses for spec resolution. They are chat
      // models on a subscription and embed nothing, so an embedding picker gets none of them.
      const cliModels = mode === "embedding" ? [] : cliModelIds(provider);
      if (cliModels.length > 0) return reply.send({ models: cliModels, source: "catalog" });

      const catalog = await getCatalog();
      if (!catalog) {
        return reply.send({
          models: [],
          source: "unavailable",
          reason: "Couldn't reach the model catalog.",
        });
      }
      return reply.send({
        models: litellmModelsForProvider(provider, catalog, mode),
        source: "catalog",
      });
    }
  );

  app.post(
    "/api/v1/llm-config/test-connection",
    {
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_RESOLVE)],
      schema: {
        description:
          "Make one live call to a single provider entry and report what it proved. Admin only. The entry is taken from the body rather than from the saved config, so an operator can prove a model works *before* committing it. `kind: chat` asks the model for a word back and returns its `reply`; `kind: embedding` embeds a short string and returns the `dimension` it got. Credentials are resolved from stored secrets by `api_key_ref` and are never accepted in, or echoed by, this route. `verdict` is `reachable`, `degraded` (the provider answered but refused or throttled) or `unreachable`.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["provider", "model"],
          properties: {
            kind: { type: "string", enum: ["chat", "embedding"], default: "chat" },
            provider: { type: "string" },
            model: { type: "string" },
            api_key_ref: { type: "string" },
            base_url: { type: "string" },
            resource_name: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["verdict"],
            properties: {
              verdict: { type: "string", enum: ["reachable", "degraded", "unreachable"] },
              detail: { type: "string" },
              reply: { type: "string" },
              latencyMs: { type: "number" },
              dimension: { type: "number" },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        kind?: "chat" | "embedding";
        provider: string;
        model: string;
        api_key_ref?: string;
        base_url?: string;
        resource_name?: string;
      };
      if (!body.provider.trim() || !body.model.trim()) {
        return reply.code(422).send({ error: "provider and model are required" });
      }
      const entry = {
        provider: body.provider.trim(),
        model: body.model.trim(),
        ...(body.api_key_ref ? { api_key_ref: body.api_key_ref } : {}),
        ...(body.base_url ? { base_url: body.base_url } : {}),
        ...(body.resource_name ? { resource_name: body.resource_name } : {}),
      };
      try {
        // biome-ignore lint/suspicious/noExplicitAny: entry shapes are validated by the body schema.
        const target = entry as any;
        const report =
          body.kind === "embedding"
            ? await checkEmbeddingReachability(await createEmbeddingModel(target, secrets))
            : await checkModelReachability(await createModel(target, secrets));
        return reply.send(report);
      } catch (err) {
        // A model that cannot even be constructed — an unknown provider, or a missing secret the
        // entry names — is a configuration answer, not a 500. It is exactly what the operator
        // pressed the button to find out.
        req.log.info(
          { err, provider: entry.provider },
          "llm test-connection could not build model"
        );
        return reply.send({
          verdict: "unreachable",
          detail:
            err instanceof Error && err.message
              ? err.message
              : "this entry could not be turned into a model",
        });
      }
    }
  );

  app.put(
    "/api/v1/llm-config",
    {
      preHandler: [requireAuth, requireAuthorization(LLM_CONFIG_WRITE)],
      schema: {
        description:
          "Replace the LLM config (admin only). Each model's spec (pricing/context/capabilities) is auto-resolved from LiteLLM and pinned; unresolved models require an explicit positive context window. `?refresh=true` re-resolves all. Validated before write; the soul is committed and the LlmService reloaded.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: { type: "object", properties: { refresh: { type: "boolean" } } },
        body: LlmConfigRouteSchema,
        response: {
          200: LlmConfigRouteSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
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

      // Auto-pin specs for models missing one (or all, with ?refresh=true) for cost tracking.
      // without a per-model click. Best-effort — a LiteLLM outage saves the config unchanged.
      const { refresh } = req.query as { refresh?: boolean };
      config = await enrichSpecs(config, refresh === true);
      const capacityProblem = validateRoutingCapacity(config);
      if (capacityProblem) {
        return reply.code(422).send({ error: capacityProblem });
      }

      const { content: currentManifest, baseCommit } = await soulWriter.readWithBase("Settings");
      try {
        await soulWriter.apply({
          subject: "soul: update llm config",
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          expectedBaseCommit: baseCommit,
          changes: [
            {
              op: "put",
              target: { kind: "Settings" },
              content: mergeLlmConfigIntoSoulYaml(currentManifest, config),
            },
          ],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const mapped = soulWriteHttpError(e);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw e;
      }
      await soulLoader.reload();
      await llmService.init(soulLoader.llmConfig, secrets, app.log);

      await auditWrite(req, "llm-config.update", "soul:llm-config", {
        tiers: Object.keys((config as { tiers?: Record<string, unknown> }).tiers ?? {}),
      });
      return reply.send(soulLoader.llmConfig);
    }
  );
}
