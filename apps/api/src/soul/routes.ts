import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { readSoulFile, resolveSafe, UnsafePathError, walkTree } from "./tree";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function registerSoulRoutes(
  app: FastifyInstance,
  gitSync: GitSyncService,
  requireAuth: PreHandler
): void {
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
      const result = await gitSync.commit(message);
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
}
