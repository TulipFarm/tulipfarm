import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter, redactRemoteUrl } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import { patchSoulConfig, readSoulConfig, SOUL_GIT_CREDENTIAL_KEY } from "../setup/soul-config";
import { commitActorFromRequest } from "./commit-actor";
import { readSoulFile, resolveSafe, UnsafePathError, walkTree } from "./tree";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** The business profile as both `GET` and `PUT /api/v1/business` return it. */
const BusinessProfileSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    website: { type: "string" },
  },
  required: ["name", "description", "website"],
} as const;

export function registerSoulRoutes(
  app: FastifyInstance,
  gitSync: GitSyncService,
  requireAuth: PreHandler,
  secretsService?: SecretsService,
  // Optional: record direct Soul config writes as audit evidence. The git-remote route below is
  // the sharpest of these — it decides where the whole business's Soul repository is pushed.
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
  // Recursive node schema for the soul tree response (self-referencing children).
  app.addSchema({
    $id: "soulTreeNode",
    type: "object",
    properties: {
      name: { type: "string" },
      path: { type: "string" },
      type: { type: "string", enum: ["file", "dir"] },
      size: { type: "number" },
      children: { type: "array", items: { $ref: "soulTreeNode#" } },
    },
    required: ["name", "path", "type"],
  });
  app.post(
    "/api/v1/soul/commit",
    {
      preHandler: requireAuth,
      schema: {
        description: "Stage all soul changes and commit as tulipfarm-bot.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              sha: { type: "string" },
              filesChanged: { type: "number" },
            },
            required: ["sha", "filesChanged"],
          },
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { message } = req.body as { message: string };
      const result = await gitSync.commit(message, commitActorFromRequest(req));
      if (result.sha === "") {
        return reply.code(204).send();
      }
      return reply.send(result);
    }
  );

  app.post(
    "/api/v1/soul/push",
    {
      preHandler: requireAuth,
      schema: {
        description: "Push committed soul changes to origin/main.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { pushed: { type: "boolean" } },
            required: ["pushed"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const pushed = await gitSync.push();
      return reply.send({ pushed });
    }
  );

  app.get(
    "/api/v1/soul/tree",
    {
      preHandler: requireAuth,
      schema: {
        description: "Read-only recursive file tree of the soul git repo (excludes .git).",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { root: { type: "array", items: { $ref: "soulTreeNode#" } } },
            required: ["root"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const soulRoot = gitSync.path;
      try {
        const root = await walkTree(soulRoot, soulRoot);
        return reply.send({ root });
      } catch (err) {
        // Uninitialized soul (directory missing) → empty tree, not an error.
        if (isErrnoException(err) && err.code === "ENOENT") {
          return reply.send({ root: [] });
        }
        throw err;
      }
    }
  );

  app.get(
    "/api/v1/soul/file",
    {
      preHandler: requireAuth,
      schema: {
        description: "Read-only raw content of a single soul file (path-traversal guarded).",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              size: { type: "number" },
              language: { type: "string" },
              binary: { type: "boolean" },
              tooLarge: { type: "boolean" },
            },
            required: ["path", "content", "size", "language"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { path } = req.query as { path: string };
      try {
        const abs = await resolveSafe(gitSync.path, path);
        const file = await readSoulFile(abs, path);
        return reply.send(file);
      } catch (err) {
        if (err instanceof UnsafePathError) {
          return reply.code(400).send({ error: err.message });
        }
        if (isErrnoException(err) && err.code === "ENOENT") {
          return reply.code(404).send({ error: "file not found" });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/soul/reload",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Re-emit soul.synced so registries (routines, guardrails, resources, LLM config) " +
          "reload hand-edited soul files. Dev-friendly path for remote-less souls, where the " +
          "periodic sync (which normally emits soul.synced) never runs.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          204: { type: "null" },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      gitSync.emit("soul.synced");
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/business",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read the business profile recorded in soul.yaml — the same values the agent sees as " +
          "<business-context>.",
        tags: ["business"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: BusinessProfileSchema,
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const config = await readSoulConfig(gitSync.path);
      return reply.send({
        name: typeof config.businessName === "string" ? config.businessName : "",
        description:
          typeof config.businessDescription === "string" ? config.businessDescription : "",
        website: typeof config.businessWebsite === "string" ? config.businessWebsite : "",
      });
    }
  );

  app.put(
    "/api/v1/business",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Update the business profile in soul.yaml (admin only). Re-emits soul.synced so the " +
          "change reaches the next turn's prompt instead of waiting for a periodic sync.",
        tags: ["business"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 2000 },
            website: { type: "string", maxLength: 500 },
          },
        },
        response: {
          200: BusinessProfileSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (req.user?.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const body = req.body as { name: string; description?: string; website?: string };
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      const description = body.description?.trim() ?? "";
      const website = body.website?.trim() ?? "";

      await patchSoulConfig(gitSync.path, {
        businessName: name,
        businessDescription: description,
        businessWebsite: website,
      });
      await gitSync
        .commit("chore: update business profile", commitActorFromRequest(req))
        .catch(() => {});
      // Without this the manifest in memory keeps answering with the old profile until the next
      // periodic sync — which never runs at all on a remote-less soul.
      gitSync.emit("soul.synced");

      await auditWrite(req, "soul-config.update", "soul:business-profile", {
        hasDescription: description.length > 0,
        hasWebsite: website.length > 0,
      });
      return reply.send({ name, description, website });
    }
  );

  if (!secretsService) return;

  app.get(
    "/api/v1/soul/git-config",
    {
      preHandler: requireAuth,
      schema: {
        description: "Read the soul git remote config and live sync status.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              remoteUrl: { type: "string" },
              credentialSet: { type: "boolean" },
              status: {
                type: "object",
                properties: {
                  remoteConfigured: { type: "boolean" },
                  ahead: { type: "number" },
                  behind: { type: "number" },
                  headSha: { type: ["string", "null"] },
                  lastSyncError: { type: ["string", "null"] },
                  lastSyncAt: { type: ["string", "null"] },
                },
                required: [
                  "remoteConfigured",
                  "ahead",
                  "behind",
                  "headSha",
                  "lastSyncError",
                  "lastSyncAt",
                ],
              },
            },
            required: ["credentialSet", "status"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const [config, secrets, status] = await Promise.all([
        readSoulConfig(gitSync.path),
        secretsService.list(),
        gitSync.getStatus(),
      ]);
      return reply.send({
        remoteUrl: config.gitRemoteUrl,
        credentialSet: secrets.some((s) => s.key === SOUL_GIT_CREDENTIAL_KEY),
        status: {
          remoteConfigured: status.remoteConfigured,
          ahead: status.ahead,
          behind: status.behind,
          headSha: status.headSha,
          lastSyncError: status.lastSyncError,
          lastSyncAt: status.lastSyncAt,
        },
      });
    }
  );

  app.post(
    "/api/v1/soul/sync",
    {
      preHandler: requireAuth,
      schema: {
        description: "Manually trigger a sync against the configured soul git remote.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        await gitSync.syncNow();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `Sync failed: ${message}` });
      }
      return reply.code(204).send();
    }
  );

  app.put(
    "/api/v1/soul/git-config",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Configure (or reconfigure) the soul git remote + credential and sync immediately.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["remoteUrl"],
          properties: {
            remoteUrl: { type: "string", minLength: 1 },
            credential: { type: "string" },
          },
        },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { remoteUrl?: unknown; credential?: unknown };
      const remoteUrl = typeof body.remoteUrl === "string" ? body.remoteUrl.trim() : "";
      const credential = typeof body.credential === "string" ? body.credential.trim() : "";
      if (!remoteUrl) return reply.code(400).send({ error: "remoteUrl is required" });

      await patchSoulConfig(gitSync.path, { gitRemoteUrl: remoteUrl });
      if (credential) {
        await secretsService.set(SOUL_GIT_CREDENTIAL_KEY, credential);
      }
      let syncError: string | undefined;
      try {
        const resolvedCredential = credential || undefined;
        await gitSync.configureRemote(remoteUrl, async () => resolvedCredential);
      } catch (err) {
        syncError = err instanceof Error ? err.message : String(err);
      }
      // Emitted whether or not the sync succeeded: the config write and the credential store
      // above have already landed durably, so a remote that fails to connect is still a remote
      // that was configured -- which is exactly what an auditor asks about. The failure text is
      // deliberately not recorded; git echoes the remote URL into its errors and this ledger is
      // append-only. The remote is host-only for the same reason: it can embed a credential.
      await auditWrite(req, "soul-config.git-remote", "soul:git-remote", {
        remote: redactRemoteUrl(remoteUrl),
        credentialProvided: credential.length > 0,
        synced: syncError === undefined,
      });
      if (syncError) {
        return reply.code(400).send({ error: `Failed to sync with remote: ${syncError}` });
      }
      return reply.code(204).send();
    }
  );
}
