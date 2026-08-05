import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import type {
  GitSyncService,
  IntegrationManifest,
  SoulIntegration,
  SoulLoader,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import { ErrorSchema } from "../auth/schemas";
import type { BundledIntegration } from "../soul/integrations/bundled";
import { deleteConnectionSecrets, sealConnectionEnv } from "./connection-env";

/*
 * Generic connect/disconnect backend for Soul-declared integrations (manifest.yml + optional
 * connection.yaml, packages/soul/src/published-loader.ts's loadIntegrations()). Mirrors Skills'
 * install/delete pattern (apps/api/src/soul/skills/routes.ts) — write files under the soul repo,
 * one gitSync.withSync() commit, soulLoader.reload(). No scan/install/marketplace/oauth routes:
 * those are out of scope (arbitrary third-party integration installs, deferred to a future task).
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
type ConnectionStatus = "connected" | "disconnected";

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface MergedIntegration {
  slug: string;
  manifest: IntegrationManifest;
  connected: boolean;
  connectionEnv?: Record<string, string>;
  setupGuide?: string;
}

// The manifest and setup guide are static, code-shipped content — a business never customizes
// scopes, field instructions, or the app-manifest text of a bundled integration. Once an
// integration is installed, only its connection state (enabled/env) is soul-owned; the manifest
// itself always comes from the bundled template so a code update reaches installed integrations
// without reinstalling. Soul's own manifest.yml copy is kept only as an install-time record, not
// read back.
function mergeIntegrations(
  soulLoader: SoulLoader,
  bundled: ReadonlyMap<string, BundledIntegration>
): Map<string, MergedIntegration> {
  const merged = new Map<string, MergedIntegration>();
  for (const [slug, bundledEntry] of bundled) {
    merged.set(slug, {
      slug,
      manifest: bundledEntry.manifest,
      connected: false,
      setupGuide: bundledEntry.setupGuide,
    });
  }
  for (const [slug, soulEntry] of soulLoader.integrations) {
    const bundledEntry = bundled.get(slug);
    merged.set(slug, {
      slug,
      manifest: bundledEntry?.manifest ?? soulEntry.manifest,
      connected: soulEntry.connection?.enabled === true,
      connectionEnv: soulEntry.connection?.env,
      setupGuide: bundledEntry?.setupGuide ?? soulEntry.setupGuide,
    });
  }
  return merged;
}

function toSummary(entry: MergedIntegration) {
  return {
    name: entry.slug,
    type: entry.manifest.egress?.type ?? "none",
    description: entry.manifest.description,
    version: entry.manifest.version,
    maintainer: entry.manifest.maintainer,
    status: (entry.connected ? "connected" : "disconnected") as ConnectionStatus,
  };
}

function toDetail(entry: MergedIntegration) {
  return {
    ...toSummary(entry),
    manifest: {
      required_env: entry.manifest.required_env,
      egress: entry.manifest.egress,
      setup_guide_path: entry.manifest.setup_guide_path,
      oauth: entry.manifest.oauth,
      install_manifest: entry.manifest.install_manifest
        ? JSON.stringify(entry.manifest.install_manifest, null, 2)
        : undefined,
    },
    connected: entry.connected,
    setupGuide: entry.setupGuide,
  };
}

const IntegrationSummarySchema = {
  type: "object",
  required: ["name", "type", "status"],
  properties: {
    name: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    version: { type: "string" },
    maintainer: { type: "string" },
    status: { type: "string", enum: ["connected", "disconnected"] },
  },
};

export function registerIntegrationRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  secretsService: SecretsService,
  bundled: ReadonlyMap<string, BundledIntegration>,
  requireAuth: PreHandler,
  onConnected?: (name: string) => Promise<void>
): void {
  async function materializeIfBundledOnly(slug: string): Promise<void> {
    if (soulLoader.integrations.has(slug)) return;
    const bundledEntry = bundled.get(slug);
    if (!bundledEntry) return;
    const dir = join(gitSync.path, "integrations", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.yml"), stringifyYaml(bundledEntry.manifest), "utf8");
    if (bundledEntry.setupGuide) {
      await writeFile(join(dir, "setup-guide.md"), bundledEntry.setupGuide, "utf8");
    }
  }

  function resolve(slug: string): MergedIntegration | undefined {
    return mergeIntegrations(soulLoader, bundled).get(slug);
  }

  app.get(
    "/api/v1/integrations",
    {
      preHandler: requireAuth,
      schema: {
        description: "List Soul and bundled integrations.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["integrations"],
            properties: {
              integrations: { type: "array", items: IntegrationSummarySchema },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const merged = mergeIntegrations(soulLoader, bundled);
      return { integrations: [...merged.values()].map(toSummary) };
    }
  );

  app.get(
    "/api/v1/integrations/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single integration's manifest and connection status.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: { type: "object", additionalProperties: true },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const entry = resolve(name);
      if (!entry) return reply.code(404).send({ error: `integration not found: ${name}` });
      return toDetail(entry);
    }
  );

  app.post(
    "/api/v1/integrations/:name/connect",
    {
      preHandler: requireAuth,
      schema: {
        description: "Connect an integration: seal required env and mark it enabled.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          required: ["env"],
          properties: { env: { type: "object", additionalProperties: { type: "string" } } },
        },
        response: {
          200: {
            type: "object",
            required: ["status", "toolCount"],
            properties: { status: { type: "string" }, toolCount: { type: "number" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const { env } = req.body as { env: Record<string, string> };
      const entry = resolve(name);
      if (!entry || !NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }

      const missing = (entry.manifest.required_env ?? [])
        .filter((field) => !env[field.name])
        .map((field) => field.name);
      if (missing.length > 0) {
        return reply.code(400).send({ error: `missing required env: ${missing.join(", ")}` });
      }

      await materializeIfBundledOnly(name);
      const sealed = await sealConnectionEnv(name, entry.manifest, env, secretsService);
      const dir = join(gitSync.path, "integrations", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "connection.yaml"),
        stringifyYaml({ enabled: true, env: sealed }),
        "utf8"
      );
      await gitSync.withSync(`soul: connect integration ${name}`);
      await soulLoader.reload();
      await onConnected?.(name);
      return { status: "connected", toolCount: 0 };
    }
  );

  app.post(
    "/api/v1/integrations/:name/disconnect",
    {
      preHandler: requireAuth,
      schema: {
        description: "Disconnect an integration, keeping its sealed env for reconnect.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const soulEntry: SoulIntegration | undefined = soulLoader.integrations.get(name);
      if (!soulEntry) return reply.code(404).send({ error: `integration not connected: ${name}` });

      const dir = join(gitSync.path, "integrations", name);
      await writeFile(
        join(dir, "connection.yaml"),
        stringifyYaml({ enabled: false, env: soulEntry.connection?.env ?? {} }),
        "utf8"
      );
      await gitSync.withSync(`soul: disconnect integration ${name}`);
      await soulLoader.reload();
      return { status: "disconnected" };
    }
  );

  app.delete(
    "/api/v1/integrations/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove an installed integration from the soul repo and delete its secrets.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: { 204: { type: "null" }, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name) || !soulLoader.integrations.has(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      await rm(join(gitSync.path, "integrations", name), { recursive: true, force: true });
      await deleteConnectionSecrets(name, secretsService);
      await gitSync.withSync(`soul: remove integration ${name}`);
      await soulLoader.reload();
      return reply.code(204).send();
    }
  );
}
