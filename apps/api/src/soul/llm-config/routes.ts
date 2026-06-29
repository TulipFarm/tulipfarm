import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchLiteLlmCatalog,
  type LiteLlmCatalog,
  type LlmConfig,
  LlmConfigValidationError,
  type LlmService,
  litellmModelsForProvider,
  resolveModelSpec,
  validateLlmConfig,
} from "@tulipfarm/llm";
import { LLM_PROVIDERS, type SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";
import type { UserDoc } from "../../auth/users";

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

// Returned by GET when no llm.config.yaml exists yet, so the editor opens with empty tiers instead of
// erroring. Not itself schema-valid for PUT (tiers need ≥1 provider) — the user fills it in and saves.
const EMPTY_LLM_CONFIG = {
  tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
} as const;

const TIER_KEYS = ["quick", "standard", "complex"] as const;

/**
 * Auto-resolve + pin a LiteLLM spec onto every model that doesn't already have one, so that simply
 * adding a model and saving is enough for cost tracking (no per-model "Fetch spec" click). Best-effort:
 * if the catalog is unreachable, the config is saved unchanged; models with no LiteLLM match are left
 * spec-less (and show as "unpriced"). Existing specs are preserved — use the form's Refresh to update.
 * `force` re-resolves ALL models against a freshly-fetched catalog.
 */
async function enrichSpecs(config: LlmConfig, force: boolean): Promise<LlmConfig> {
  const all = TIER_KEYS.flatMap((t) => config.tiers[t].providers);
  if (!force && all.every((p) => p.spec)) return config; // nothing missing → no fetch
  const catalog = await getCatalog(force);
  if (!catalog) return config; // can't reach LiteLLM → save as-is
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const enrichTier = (tier: { providers: LlmConfig["tiers"]["quick"]["providers"] }) => ({
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
      quick: enrichTier(config.tiers.quick),
      standard: enrichTier(config.tiers.standard),
      complex: enrichTier(config.tiers.complex),
    },
  };
}

/*
 * LLM config editing (UI-V1-003 / LLM-V1-003). Reads and full-replaces soul/llm.config.yaml.
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
          "Read the current LLM config. A fresh instance with no llm.config.yaml gets an empty skeleton (three tiers, no providers) so the editor opens ready to configure.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: { type: "object", additionalProperties: true },
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
          "Resolve a model's spec (pricing/context/capabilities) from LiteLLM for a given provider+model, to pin into llm.config. Admin only. `spec` is null when no confident match was found (use `candidates`).",
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
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const q = req.query as { provider: string; model: string; refresh?: boolean };
      const catalog = await getCatalog(q.refresh === true);
      if (!catalog) {
        return reply.code(502).send({ error: "could not reach the LiteLLM model catalog" });
      }
      const fetchedAt = new Date().toISOString().slice(0, 10);
      return reply.send(resolveModelSpec(q.provider, q.model, catalog, fetchedAt));
    }
  );

  app.get(
    "/api/v1/llm-config/model-options",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Suggested model ids for a provider (from the LiteLLM catalog), to populate the Settings model picker. Admin only. `source: catalog` lists known ids; `source: unavailable` (+ `reason`) means the catalog couldn't be reached and the UI falls back to free-text entry.",
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
              source: { type: "string", enum: ["catalog", "unavailable"] },
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
          "Replace the LLM config (admin only). Each model's spec (pricing/context/capabilities) is auto-resolved from LiteLLM and pinned (best-effort); `?refresh=true` re-resolves all. Validated before write; the soul is committed and the LlmService reloaded.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: { type: "object", properties: { refresh: { type: "boolean" } } },
        body: { type: "object", additionalProperties: true },
        response: {
          200: { type: "object", additionalProperties: true },
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

      // Auto-pin specs for any model missing one (or all, with ?refresh=true) so cost tracking works
      // without a per-model click. Best-effort — a LiteLLM outage saves the config unchanged.
      const { refresh } = req.query as { refresh?: boolean };
      config = await enrichSpecs(config, refresh === true);

      await writeFile(join(gitSync.path, "llm.config.yaml"), stringifyYaml(config), "utf8");
      await gitSync.withSync("soul: update llm config");
      await soulLoader.reload();
      await llmService.init(soulLoader.llmConfig, secrets, app.log);

      return reply.send(soulLoader.llmConfig);
    }
  );
}
