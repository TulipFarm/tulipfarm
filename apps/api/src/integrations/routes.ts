import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  authStepProducesEnv,
  authStepSatisfied,
  type GitSyncService,
  type IntegrationManifest,
  resolveAuthSteps,
  resolveGrants,
  type SoulIntegration,
  type SoulLoader,
} from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import type { BundledIntegration } from "../soul/integrations/bundled";
import { loadIntegrationRegistry, type RegistryEntry } from "../soul/integrations/registry";
import { brandIcon } from "./brand-icon";
import { deleteConnectionSecrets, ForeignSecretRefError } from "./connection-env";
import { mergeConnectionEnv } from "./connection-writer";
import { isGitHubInstalled } from "./github-status";
import { readIntegrationLock, writeIntegrationLock } from "./install";

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
export function mergeIntegrations(
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
    installed: true,
    status: (entry.connected ? "connected" : "disconnected") as ConnectionStatus,
  };
}

/**
 * The catalog an operator browses: everything present in this deployment, plus the curated
 * third-party entries that are not installed yet.
 *
 * These are one list rather than two pages because "installed" is not a distinction an operator
 * makes — every bundled integration is installed by virtue of shipping in the image, so a tab
 * labelled that way showed things nobody installed and hid things they were looking for. What
 * matters is whether an integration is connected, which is a property of an entry, not a page.
 */
async function toCatalog(
  merged: Map<string, MergedIntegration>,
  registry: ReadonlyMap<string, RegistryEntry>
) {
  const names = [...new Set([...merged.keys(), ...registry.keys()])].sort();
  return await Promise.all(
    names.map(async (name) => {
      const entry = merged.get(name);
      const listing = registry.get(name);
      // A curated entry that is not installed has no manifest yet — nothing has been cloned — so
      // the registry's own copy is all there is to show until it is.
      const base = entry
        ? toSummary(entry)
        : {
            name,
            type: "none",
            description: undefined as string | undefined,
            version: undefined as string | undefined,
            maintainer: undefined as string | undefined,
            installed: false,
            status: "disconnected" as ConnectionStatus,
          };
      const mark = await brandIcon(entry?.manifest.icon ?? listing?.icon);
      return {
        ...base,
        title: listing?.title,
        description: base.description ?? listing?.description,
        category: listing?.category,
        homepage: listing?.homepage,
        source: listing?.source,
        iconPath: mark?.path,
        // The registry's colour is the fallback, not an override: it exists for brands the icon
        // set does not carry, so a resolved mark always keeps its own.
        iconColor: mark?.hex ?? listing?.color,
      };
    })
  );
}

async function toDetail(entry: MergedIntegration, listing?: RegistryEntry) {
  const steps = resolveAuthSteps(entry.manifest);
  const mark = await brandIcon(entry.manifest.icon ?? listing?.icon);
  return {
    ...toSummary(entry),
    // The same brand identity the catalog row showed. Landing on a detail page that drops back to
    // a bare slug reads as a different product than the one that was clicked.
    title: listing?.title,
    category: listing?.category,
    homepage: listing?.homepage,
    iconPath: mark?.path,
    iconColor: mark?.hex ?? listing?.color,
    capabilities: entry.manifest.capabilities,
    grants: resolveGrants(entry.manifest),
    manifest: {
      // Derived from the resolved flow, not read from the manifest: a manifest that declares
      // `auth` has no `required_env`, and every consumer must see one shape.
      required_env: steps.flatMap((step) => (step.kind === "fields" ? step.fields : [])),
      egress: entry.manifest.egress,
      setup_guide_path: entry.manifest.setup_guide_path,
      oauth: entry.manifest.oauth,
      install_manifest: entry.manifest.install_manifest
        ? JSON.stringify(entry.manifest.install_manifest, null, 2)
        : undefined,
    },
    auth: steps.map((step, index) => ({
      index,
      kind: step.kind,
      title: step.title,
      description: step.description,
      satisfied: authStepSatisfied(step, entry.connectionEnv ?? {}),
      // Whether finishing this step is observable at all. `satisfied` alone cannot drive a setup
      // walkthrough: a step that writes nothing is satisfied before it is started.
      producesEnv: authStepProducesEnv(step),
      fields: step.kind === "fields" ? step.fields : undefined,
    })),
    connected: entry.connected,
    setupGuide: entry.setupGuide,
  };
}

const IntegrationSummarySchema = {
  type: "object",
  required: ["name", "type", "status", "installed"],
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    category: { type: "string" },
    homepage: { type: "string" },
    /** Simple Icons path data for the brand mark; absent when the brand has none. */
    iconPath: { type: "string" },
    /** The brand's hex without `#`, from the icon set or the registry. Legibility is the client's. */
    iconColor: { type: "string" },
    version: { type: "string" },
    maintainer: { type: "string" },
    /** Git source of a curated third-party integration; absent when it ships in the image. */
    source: { type: "string" },
    installed: { type: "boolean" },
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
  onConnected?: (name: string) => Promise<void>,
  githubStatus?: { integrations: IntegrationStore; businessId: string },
  /**
   * Reconciles manifest-declared Tools against the live registry. Connect syncs through
   * `onConnected` (shared with the OAuth callback); disconnect and uninstall sync here, so
   * revoking an integration also revokes the Tools it published.
   */
  declarativeTools?: { sync: () => number; countFor: (slug: string) => number },
  // Optional: record connect/disconnect/remove as audit evidence. Connecting an integration grants
  // Agents a new external reach, which is exactly the kind of change an auditor asks about.
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
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
    // The manifest names this file, and the Soul loader treats a declared-but-missing spec as
    // fatal — so it must land with the manifest, not after it.
    if (bundledEntry.egressSpecFile) {
      await writeFile(
        join(dir, bundledEntry.egressSpecFile.file),
        bundledEntry.egressSpecFile.raw,
        "utf8"
      );
    }
    // Same contract for the ingress classifier: the manifest names it and the loader hashes it,
    // so a channel installed without its handler would fail to load rather than run unclassified.
    if (bundledEntry.ingressHandlerFile) {
      await writeFile(
        join(dir, bundledEntry.ingressHandlerFile.file),
        bundledEntry.ingressHandlerFile.raw,
        "utf8"
      );
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
        description:
          "Browse the integration catalog: everything present in this deployment, plus curated third-party entries that are not installed yet.",
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
      const githubEntry = merged.get("github");
      if (githubEntry && githubStatus) {
        githubEntry.connected = await isGitHubInstalled(githubStatus);
      }
      return { integrations: await toCatalog(merged, await loadIntegrationRegistry(app.log)) };
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
      if (name === "github" && githubStatus) {
        entry.connected = await isGitHubInstalled(githubStatus);
      }
      return await toDetail(entry, (await loadIntegrationRegistry(app.log)).get(name));
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
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const { env } = req.body as { env: Record<string, string> };
      const entry = resolve(name);
      if (!entry) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }

      // Connect completes exactly one fields step: the first one not already satisfied. All of
      // that step's fields must end up present; anything else in the payload is merged but not
      // demanded, which is what lets a multi-step flow be filled in one step at a time.
      const existingEnv = soulLoader.integrations.get(name)?.connection?.env ?? {};
      const merged = { ...existingEnv, ...env };
      const target = resolveAuthSteps(entry.manifest).find(
        (step) => step.kind === "fields" && !authStepSatisfied(step, merged)
      );
      const missing =
        target?.kind === "fields"
          ? target.fields.filter((field) => !merged[field.name]).map((field) => field.name)
          : [];
      if (missing.length > 0) {
        return reply.code(400).send({ error: `missing required env: ${missing.join(", ")}` });
      }

      await materializeIfBundledOnly(name);
      let enabled: boolean;
      let connectedNow: boolean;
      try {
        ({ enabled, connectedNow } = await mergeConnectionEnv(
          { gitSync, soulLoader, secrets: secretsService },
          {
            slug: name,
            manifest: entry.manifest,
            patch: env,
            commitMessage: `soul: connect integration ${name}`,
          }
        ));
      } catch (error) {
        if (error instanceof ForeignSecretRefError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
      if (connectedNow) await onConnected?.(name);
      // Field *names* only. Values are credentials, and `safeMetadata` would reject them anyway.
      await auditWrite(req, "integration.connect", `integration:${name}`, {
        status: enabled ? "connected" : "pending",
        fields: Object.keys(env),
      });
      return {
        status: enabled ? "connected" : "pending",
        toolCount: declarativeTools?.countFor(name) ?? 0,
      };
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
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not connected: ${name}` });
      }
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
      // An agent must not keep calling a provider whose credential the operator just revoked.
      const revoked = declarativeTools?.sync();
      await auditWrite(req, "integration.disconnect", `integration:${name}`, {
        ...(revoked === undefined ? {} : { toolsResynced: revoked }),
      });
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
      // Drop the provenance record too, so a later reinstall from a different source is not
      // reported against the old one.
      const lock = await readIntegrationLock(gitSync.path);
      if (name in lock.integrations) {
        delete lock.integrations[name];
        await writeIntegrationLock(gitSync.path, lock);
      }
      await gitSync.withSync(`soul: remove integration ${name}`);
      await soulLoader.reload();
      declarativeTools?.sync();
      await auditWrite(req, "integration.remove", `integration:${name}`, { secretsDeleted: true });
      return reply.code(204).send();
    }
  );
}
