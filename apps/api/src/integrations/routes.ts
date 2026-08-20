import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SecretsService } from "@tulipfarm/secrets";
import type { BundledIntegration } from "@tulipfarm/soul";
import {
  authStepProducesEnv,
  authStepSatisfied,
  type IntegrationManifest,
  isSoulWriteError,
  loadIntegrationRegistry,
  type RegistryEntry,
  resolveAuthSteps,
  resolveGrants,
  type SoulIntegration,
  type SoulLoader,
  type SoulWrite,
  type SoulWriter,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as stringifyYaml } from "yaml";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";
import { brandIcon } from "./brand-icon";
import { deleteConnectionSecrets, ForeignSecretRefError } from "./connection-env";
import { mergeConnectionEnv } from "./connection-writer";
import { isGitHubInstalled } from "./github-status";
import { readIntegrationLock, serializeIntegrationLock } from "./install";

/**
 * Generic Soul integration connect/disconnect backend; no scan, marketplace, or bespoke OAuth
 * routes.
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

// Bundled manifests stay code-owned after install; Soul owns only connection state.
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
    const manifest = bundledEntry?.manifest ?? soulEntry.manifest;
    // Soul entry has no manifest of its own (bundled, code-owned) and no bundled entry either —
    // nothing to catalog.
    if (manifest === undefined) continue;
    merged.set(slug, {
      slug,
      manifest,
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

/** Catalog mixes shipped and curated integrations; connected state is per entry. */
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
    iconPath: { type: "string" },
    iconColor: { type: "string" },
    version: { type: "string" },
    maintainer: { type: "string" },
    source: { type: "string" },
    installed: { type: "boolean" },
    status: { type: "string", enum: ["connected", "disconnected"] },
  },
};

export function registerIntegrationRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  soulWriter: SoulWriter,
  secretsService: SecretsService,
  bundled: ReadonlyMap<string, BundledIntegration>,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  onConnected?: (name: string) => Promise<void>,
  githubStatus?: { integrations: IntegrationStore; businessId: string },
  /** Disconnect and uninstall sync here so revoked integrations revoke their Tools. */
  declarativeTools?: { sync: () => number; countFor: (slug: string) => number },
  // Optional: record connect/disconnect/remove as audit evidence. Connecting an integration grants
  // Agents a new external reach, which is exactly the kind of change an auditor asks about.
  audit?: AuditService
): void {
  const auditWrite = makeSoulAuditWriter(audit);
  // Materialize a bundled-only integration into the soul repo so its connection state has a home.
  // The manifest is authored as the legacy `manifest.yml` (definitionMode "legacy"), and its
  // companions land in the SAME atomic changeset — the loader treats a declared-but-missing egress
  // spec or ingress handler as fatal, so a partial materialization must never be committable.
  async function materializeIfBundledOnly(
    slug: string,
    actor: ReturnType<typeof commitActorFromRequest>
  ): Promise<void> {
    if (soulLoader.integrations.has(slug)) return;
    const bundledEntry = bundled.get(slug);
    if (!bundledEntry) return;
    const changes: SoulWrite[] = [
      {
        op: "put",
        target: { kind: "Integration", slug, definitionMode: "legacy" },
        content: stringifyYaml(bundledEntry.manifest),
      },
    ];
    if (bundledEntry.setupGuide) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug, companion: "setup-guide.md" },
        content: bundledEntry.setupGuide,
      });
    }
    if (bundledEntry.egressSpecFile) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug, companion: bundledEntry.egressSpecFile.file },
        content: bundledEntry.egressSpecFile.raw,
      });
    }
    // Same contract for the ingress classifier: the manifest names it and the loader hashes it,
    // so a channel installed without its handler would fail to load rather than run unclassified.
    if (bundledEntry.ingressHandlerFile) {
      changes.push({
        op: "put",
        target: { kind: "Integration", slug, companion: bundledEntry.ingressHandlerFile.file },
        content: bundledEntry.ingressHandlerFile.raw,
      });
    }
    await soulWriter.apply({
      subject: `soul: materialize integration ${slug}`,
      source: "api",
      actor,
      businessId: DEPLOYMENT_BUSINESS_ID,
      changes,
    });
    await soulLoader.reload();
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
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.connect",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
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
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
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

      const actor = commitActorFromRequest(req);
      let enabled: boolean;
      let connectedNow: boolean;
      try {
        await materializeIfBundledOnly(name, actor);
        ({ enabled, connectedNow } = await mergeConnectionEnv(
          { soulWriter, soulLoader, secrets: secretsService },
          {
            slug: name,
            manifest: entry.manifest,
            patch: env,
            commitMessage: `soul: connect integration ${name}`,
            actor,
          }
        ));
      } catch (error) {
        if (error instanceof ForeignSecretRefError) {
          return reply.code(400).send({ error: error.message });
        }
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
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
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.disconnect",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
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
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name)) {
        return reply.code(404).send({ error: `integration not connected: ${name}` });
      }
      const soulEntry: SoulIntegration | undefined = soulLoader.integrations.get(name);
      if (!soulEntry) return reply.code(404).send({ error: `integration not connected: ${name}` });

      try {
        await soulWriter.apply({
          subject: `soul: disconnect integration ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [
            {
              op: "put",
              target: { kind: "Integration", slug: name, companion: "connection.yaml" },
              content: stringifyYaml({ enabled: false, env: soulEntry.connection?.env ?? {} }),
            },
          ],
        });
      } catch (error) {
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
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
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.remove",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        description: "Remove an installed integration from the soul repo and delete its secrets.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          204: { type: "null" },
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
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name) || !soulLoader.integrations.has(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      await deleteConnectionSecrets(name, secretsService);
      // Drop the provenance record too, so a later reinstall from a different source is not
      // reported against the old one. The lock is a root singleton, so it never overlaps the
      // integration directory this changeset also deletes.
      const lock = readIntegrationLock(soulWriter);
      const changes: SoulWrite[] = [{ op: "deleteArtifact", kind: "Integration", slug: name }];
      if (name in lock.integrations) {
        delete lock.integrations[name];
        changes.push({
          op: "put",
          target: { kind: "IntegrationsLock" },
          content: serializeIntegrationLock(lock),
        });
      }
      try {
        await soulWriter.apply({
          subject: `soul: remove integration ${name}`,
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes,
        });
      } catch (error) {
        if (isSoulWriteError(error)) {
          const mapped = soulWriteHttpError(error);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
      await soulLoader.reload();
      declarativeTools?.sync();
      await auditWrite(req, "integration.remove", `integration:${name}`, { secretsDeleted: true });
      return reply.code(204).send();
    }
  );
}
