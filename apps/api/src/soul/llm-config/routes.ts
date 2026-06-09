import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type LlmConfig,
  LlmConfigValidationError,
  type LlmService,
  validateLlmConfig,
} from "@tulipfarm/llm";
import { LLM_PROVIDERS, type SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";
import type { UserDoc } from "../../auth/users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

// Returned by GET when no llm.config.yaml exists yet, so the editor opens with empty tiers instead of
// erroring. Not itself schema-valid for PUT (tiers need ≥1 provider) — the user fills it in and saves.
const EMPTY_LLM_CONFIG = {
  tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
} as const;

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

  app.put(
    "/api/v1/llm-config",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Replace the LLM config (admin only). Validated before write; the soul is committed and the LlmService reloaded.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
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

      await writeFile(join(gitSync.path, "llm.config.yaml"), stringifyYaml(config), "utf8");
      await gitSync.withSync("soul: update llm config");
      await soulLoader.reload();
      await llmService.init(soulLoader.llmConfig, secrets, app.log);

      return reply.send(soulLoader.llmConfig);
    }
  );
}
