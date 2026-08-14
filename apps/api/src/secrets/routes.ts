import { CODEX_AUTH_SECRET_KEY, parseCodexAuth } from "@tulipfarm/llm";
import type { SecretsService, SecretType } from "@tulipfarm/secrets";
import { InvalidSecretKeyError } from "@tulipfarm/secrets";
import type { CommitActor } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import { commitActorFromRequest } from "../soul/commit-actor";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const SecretMetaSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    type: { type: "string", enum: ["user-provided", "auto-generated"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["key", "type", "createdAt", "updatedAt"],
} as const;

export function registerSecretsRoutes(
  app: FastifyInstance,
  secretsService: SecretsService,
  requireAuth: PreHandler,
  opts?: {
    /** Called after a successful delete; errors are caught and logged — never surface to the caller. */
    onSecretDeleted?: (key: string, actor: CommitActor) => Promise<void>;
  }
): void {
  app.get(
    "/api/v1/secrets/status",
    {
      preHandler: requireAuth,
      schema: {
        description: "List all secret keys and metadata. Values are never returned.",
        tags: ["secrets"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              secrets: { type: "array", items: SecretMetaSchema },
            },
            required: ["secrets"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const secrets = await secretsService.list();
      return reply.send({ secrets });
    }
  );

  app.put(
    "/api/v1/secrets/:key",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create or update a secret (admin only).",
        tags: ["secrets"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["value"],
          properties: {
            value: { type: "string" },
            type: { type: "string", enum: ["user-provided", "auto-generated"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { key } = req.params as { key: string };
      const body = (req.body ?? {}) as { value?: unknown; type?: unknown };

      const value = typeof body.value === "string" ? body.value : "";
      if (!value) {
        return reply.code(400).send({ error: "value is required" });
      }

      const type =
        body.type === "auto-generated" ? ("auto-generated" as SecretType) : "user-provided";

      // The Codex credential is the only secret with an internal shape the product depends on: a
      // subscription-mode auth.json. Validating on write means Settings rejects a paste of the
      // wrong file (or an API-key-mode blob, which this provider deliberately does not support)
      // with a useful message, instead of storing it and failing inside a chat turn later.
      if (key === CODEX_AUTH_SECRET_KEY) {
        try {
          parseCodexAuth(value);
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : "auth.json is invalid" });
        }
      }

      try {
        await secretsService.set(key, value, type);
      } catch (err) {
        if (err instanceof InvalidSecretKeyError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      return reply.send({ key });
    }
  );

  app.delete(
    "/api/v1/secrets/:key",
    {
      preHandler: requireAuth,
      schema: {
        description: "Delete a secret (admin only). Idempotent.",
        tags: ["secrets"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }

      const { key } = req.params as { key: string };
      await secretsService.delete(key);

      if (opts?.onSecretDeleted) {
        try {
          await opts.onSecretDeleted(key, commitActorFromRequest(req));
        } catch (err) {
          app.log.error(
            `[secrets] post-delete cascade for ${key} failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return reply.code(204).send();
    }
  );
}
