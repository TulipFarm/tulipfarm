import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { GitSyncService, IntegrationManifest, OAuthConfig, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stringify as toYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";
import type { McpClientService } from "../../integrations/mcp-client-service";
import { hashContent, readIntegrationsLock, sourceType, writeIntegrationsLock } from "./lock";

/*
 * Integrations HTTP surface (INT-V1 / MCP-V1-001). V1 supports type=mcp only.
 * Lifecycle: scan a git repo → install (write manifest.json to soul) → connect (write
 * connection.yaml + start MCP subprocess) → disconnect → delete.
 * No audit gate: MCP is process-isolated by construction (INT-V1-001).
 */

const execFileP = promisify(execFile);

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_TTL_MS = 10 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 60_000;
const MAX_SCANS = 25;

export interface DiscoveredIntegration {
  name: string;
  description?: string;
  type: string;
  manifestPath: string;
  content: string;
  setupGuideContent?: string;
}

interface OAuthStateEntry {
  name: string;
  env: Record<string, string>;
  oauthConfig: OAuthConfig;
  redirectUri: string;
  expires: number;
}

const oauthStates = new Map<string, OAuthStateEntry>();

function pruneOAuthStates(now: number): void {
  for (const [id, entry] of oauthStates) {
    if (entry.expires <= now) oauthStates.delete(id);
  }
}

interface ScanEntry {
  source: string;
  ref: string;
  integrations: DiscoveredIntegration[];
  expires: number;
}

const scans = new Map<string, ScanEntry>();

function pruneScans(now: number): void {
  for (const [id, entry] of scans) {
    if (entry.expires <= now) scans.delete(id);
  }
  while (scans.size > MAX_SCANS) {
    const oldest = scans.keys().next().value;
    if (oldest === undefined) break;
    scans.delete(oldest);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Only GitHub slugs or http(s)/file URLs allowed — same SSRF rule as skills.
function isAllowedSource(source: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(source) || /^(https?|file):\/\//.test(source);
}

function normalizeGitUrl(source: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}.git`;
  return source;
}

async function cloneToTemp(source: string): Promise<{ dir: string; ref: string }> {
  const dir = await mkdtemp(join(tmpdir(), "integration-scan-"));
  await execFileP("git", ["clone", "--depth", "1", normalizeGitUrl(source), dir], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, ref: stdout.trim() };
}

/**
 * Walk a directory for manifest.json files (type=mcp only). Exported for testing.
 */
export async function discoverIntegrations(root: string): Promise<DiscoveredIntegration[]> {
  const out: DiscoveredIntegration[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name === "manifest.json") {
        try {
          const content = await readFile(full, "utf8");
          const parsed = JSON.parse(content) as Partial<IntegrationManifest>;
          if (parsed.type !== "mcp") continue; // V1: mcp only
          const name = asString(parsed.name) ?? basename(dirname(full));
          if (!NAME_RE.test(name)) continue;
          let setupGuideContent: string | undefined;
          if (parsed.setup_guide_path) {
            try {
              setupGuideContent = await readFile(
                join(dirname(full), parsed.setup_guide_path),
                "utf8"
              );
            } catch {
              // setup guide is optional
            }
          }
          out.push({
            name,
            description: asString(parsed.description),
            type: "mcp",
            manifestPath: relative(root, full),
            content,
            setupGuideContent,
          });
        } catch {
          // skip invalid manifests
        }
      }
    }
  }
  await walk(root, 0);
  return out;
}

function installStatus(
  integration: DiscoveredIntegration,
  lock: Awaited<ReturnType<typeof readIntegrationsLock>>,
  soulLoader: SoulLoader
): { installed: boolean; updateAvailable: boolean } {
  const installed = soulLoader.integrations.has(integration.name);
  const lockedHash = lock.integrations[integration.name]?.hash;
  const updateAvailable =
    installed &&
    !!lockedHash &&
    lockedHash !== createHash("sha256").update(integration.content).digest("hex");
  return { installed, updateAvailable };
}

// Marketplace registry.json — parallel to marketplace.json for skills
interface RegistryEntry {
  name?: string;
  description?: string;
  type?: string;
  verified?: boolean;
}

async function readRegistry(dir: string): Promise<Map<string, RegistryEntry>> {
  const byName = new Map<string, RegistryEntry>();
  try {
    const parsed = JSON.parse(await readFile(join(dir, "registry.json"), "utf8")) as {
      integrations?: RegistryEntry[];
    };
    for (const entry of Array.isArray(parsed.integrations) ? parsed.integrations : []) {
      const key = asString(entry.name);
      if (key && !byName.has(key)) byName.set(key, entry);
    }
  } catch {
    // missing registry.json is fine
  }
  return byName;
}

function marketplaceSource(): string {
  return process.env.INTEGRATIONS_MARKETPLACE_SOURCE ?? "tulipfarm/integrations";
}

interface MarketplaceResponse {
  scanId: string;
  source: string;
  integrations: {
    name: string;
    description?: string;
    verified?: boolean;
    installed: boolean;
    updateAvailable: boolean;
  }[];
}

const marketplaceCache = new Map<
  string,
  { scanId: string; expires: number; response: MarketplaceResponse }
>();

const IntegrationSummaryProps = {
  name: { type: "string" },
  description: { type: "string" },
  status: { type: "string", enum: ["connected", "connecting", "error", "disconnected"] },
  errorMessage: { type: "string" },
} as const;

export function registerIntegrationRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  mcpClient: McpClientService,
  requireAuth: PreHandler
): void {
  // List all installed integrations with runtime status
  app.get(
    "/api/v1/integrations",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List MCP integrations installed in the soul repo, with runtime connection status.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["integrations"],
            properties: {
              integrations: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "type", "status"],
                  properties: {
                    ...IntegrationSummaryProps,
                    type: { type: "string" },
                    version: { type: "string" },
                    maintainer: { type: "string" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const integrations = Array.from(soulLoader.integrations.values()).map((i) => ({
        name: i.name,
        type: i.manifest.type,
        description: i.manifest.description,
        version: i.manifest.version,
        maintainer: i.manifest.maintainer,
        status: mcpClient.getStatus(i.name),
        errorMessage: mcpClient.getErrorMessage(i.name),
      }));
      return { integrations };
    }
  );

  // Browse the official integrations marketplace
  app.get(
    "/api/v1/integrations/marketplace",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Browse the official integrations marketplace (tulipfarm/integrations). Returns a scanId usable with the install endpoint.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["scanId", "source", "integrations"],
            properties: {
              scanId: { type: "string" },
              source: { type: "string" },
              integrations: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "installed", "updateAvailable"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    verified: { type: "boolean" },
                    installed: { type: "boolean" },
                    updateAvailable: { type: "boolean" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "no-store");
      const source = marketplaceSource();
      const now = Date.now();
      const cached = marketplaceCache.get(source);
      if (cached && cached.expires > now && scans.has(cached.scanId)) return cached.response;

      let dir: string | undefined;
      try {
        const clone = await cloneToTemp(source);
        dir = clone.dir;
        const discovered = await discoverIntegrations(dir);
        const registry = await readRegistry(dir);
        const lock = await readIntegrationsLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(now);
        scans.set(scanId, {
          source,
          ref: clone.ref,
          integrations: discovered,
          expires: now + SCAN_TTL_MS,
        });
        const response: MarketplaceResponse = {
          scanId,
          source,
          integrations: discovered.map((i) => {
            const meta = registry.get(i.name);
            return {
              name: i.name,
              description: i.description ?? asString(meta?.description),
              verified: meta?.verified,
              ...installStatus(i, lock, soulLoader),
            };
          }),
        };
        marketplaceCache.set(source, { scanId, expires: now + SCAN_TTL_MS, response });
        return response;
      } catch (e) {
        return reply.code(502).send({
          error: `marketplace unavailable: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  );

  // Get single integration detail
  app.get(
    "/api/v1/integrations/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single integration including its manifest and connection status.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["name", "type", "status", "manifest"],
            properties: {
              ...IntegrationSummaryProps,
              type: { type: "string" },
              manifest: { type: "object", additionalProperties: true },
              connected: { type: "boolean" },
              setupGuide: { type: "string" },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const integration = soulLoader.integrations.get(name);
      if (!integration) return reply.code(404).send({ error: `integration not found: ${name}` });
      return {
        name: integration.name,
        type: integration.manifest.type,
        description: integration.manifest.description,
        status: mcpClient.getStatus(name),
        errorMessage: mcpClient.getErrorMessage(name),
        manifest: integration.manifest,
        connected: integration.connection?.enabled === true,
        setupGuide: integration.setupGuide,
      };
    }
  );

  // Scan a git repo for MCP integrations
  app.post(
    "/api/v1/integrations/scan",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Clone a git repo and discover installable MCP integration manifest.json files.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: { source: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["scanId", "integrations"],
            properties: {
              scanId: { type: "string" },
              integrations: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "type", "installed", "updateAvailable"],
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    description: { type: "string" },
                    installed: { type: "boolean" },
                    updateAvailable: { type: "boolean" },
                  },
                },
              },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source } = req.body as { source: string };
      if (!isAllowedSource(source)) {
        return reply.code(400).send({
          error: "source must be a github owner/repo slug or an http(s)/file URL",
        });
      }
      let dir: string | undefined;
      try {
        const clone = await cloneToTemp(source);
        dir = clone.dir;
        const discovered = await discoverIntegrations(dir);
        if (discovered.length === 0) {
          return reply.code(400).send({ error: "no MCP manifest.json files found in repo" });
        }
        const lock = await readIntegrationsLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, {
          source,
          ref: clone.ref,
          integrations: discovered,
          expires: Date.now() + SCAN_TTL_MS,
        });
        return {
          scanId,
          integrations: discovered.map((i) => ({
            name: i.name,
            type: i.type,
            description: i.description,
            ...installStatus(i, lock, soulLoader),
          })),
        };
      } catch (e) {
        return reply.code(400).send({
          error: `scan failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  );

  // Install integrations from a scan
  app.post(
    "/api/v1/integrations/install",
    {
      preHandler: requireAuth,
      schema: {
        description: "Install the named integrations from a scan into the soul repo.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["scanId", "names"],
          additionalProperties: false,
          properties: {
            scanId: { type: "string" },
            names: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["installed"],
            properties: { installed: { type: "array", items: { type: "string" } } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, names } = req.body as { scanId: string; names: string[] };
      const entry = scans.get(scanId);
      if (!entry) return reply.code(404).send({ error: "scan not found (it may have expired)" });

      const unique = [...new Set(names)];
      const chosen = unique.map((n) => entry.integrations.find((i) => i.name === n));
      const missing = unique.filter((_, idx) => !chosen[idx]);
      if (missing.length > 0)
        return reply.code(400).send({ error: `not in scan: ${missing.join(", ")}` });

      const installed: string[] = [];
      for (const integration of chosen as DiscoveredIntegration[]) {
        const dir = join(gitSync.path, "integrations", integration.name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "manifest.json"), integration.content, "utf8");
        if (integration.setupGuideContent) {
          await writeFile(join(dir, "setup-guide.md"), integration.setupGuideContent, "utf8");
        }
        installed.push(integration.name);
      }

      const lock = await readIntegrationsLock(gitSync.path);
      for (const integration of chosen as DiscoveredIntegration[]) {
        lock.integrations[integration.name] = {
          sourceUrl: entry.source,
          sourceType: sourceType(entry.source),
          manifestPath: integration.manifestPath,
          ref: entry.ref,
          hash: hashContent(integration.content),
        };
      }
      await writeIntegrationsLock(gitSync.path, lock);
      await gitSync.withSync(`soul: install integration(s) ${installed.join(", ")}`);
      await soulLoader.reload();
      return { installed };
    }
  );

  // Connect an installed integration (write connection.yaml + start MCP server)
  app.post(
    "/api/v1/integrations/:name/connect",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Connect an installed integration: write connection config and start the MCP server.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            env: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string" },
              toolCount: { type: "number" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name) || !soulLoader.integrations.has(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }
      const integration = soulLoader.integrations.get(name);
      if (!integration) return reply.code(404).send({ error: `integration not found: ${name}` });
      const body = (req.body as { env?: Record<string, string> } | null) ?? {};
      const connection = { enabled: true, env: body.env ?? {} };

      // Persist connection.yaml before starting (so a restart re-connects)
      const connPath = join(gitSync.path, "integrations", name, "connection.yaml");
      await writeFile(connPath, toYaml(connection), "utf8");
      await gitSync.withSync(`soul: connect integration ${name}`);
      await soulLoader.reload();

      try {
        await mcpClient.connect(name, integration.manifest, connection);
      } catch (e) {
        return reply.code(502).send({
          error: `MCP server failed to start: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      return { status: mcpClient.getStatus(name), toolCount: 0 };
    }
  );

  // Disconnect a connected integration
  app.post(
    "/api/v1/integrations/:name/disconnect",
    {
      preHandler: requireAuth,
      schema: {
        description: "Disconnect an integration: stop the MCP server and mark as disabled.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name) || !soulLoader.integrations.has(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }

      await mcpClient.disconnect(name);

      // Update connection.yaml to disabled
      const connPath = join(gitSync.path, "integrations", name, "connection.yaml");
      try {
        const integration = soulLoader.integrations.get(name);
        const existing = integration?.connection ?? {};
        await writeFile(connPath, toYaml({ ...existing, enabled: false }), "utf8");
        await gitSync.withSync(`soul: disconnect integration ${name}`);
        await soulLoader.reload();
      } catch {
        // best-effort persist
      }

      return { status: "disconnected" };
    }
  );

  // Start OAuth authorization flow for an integration
  app.post(
    "/api/v1/integrations/:name/oauth/start",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Begin OAuth authorization flow. Returns an authUrl to open in a new tab. The user's client_id and other env values must be supplied so the redirect can be pre-filled on callback.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        body: {
          type: "object",
          required: ["env"],
          additionalProperties: false,
          properties: {
            env: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["authUrl"],
            properties: { authUrl: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const integration = soulLoader.integrations.get(name);
      if (!integration) return reply.code(404).send({ error: `integration not found: ${name}` });

      const oauthConfig = integration.manifest.oauth;
      if (!oauthConfig) {
        return reply.code(400).send({ error: `integration "${name}" does not support OAuth` });
      }

      const { env } = req.body as { env: Record<string, string> };
      const clientId = env[oauthConfig.client_id_env];
      if (!clientId) {
        return reply
          .code(400)
          .send({ error: `missing required env field: ${oauthConfig.client_id_env}` });
      }

      const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:8080";
      const redirectUri = `${publicUrl}/api/v1/integrations/${name}/oauth/callback`;
      const state = randomUUID();
      const now = Date.now();
      pruneOAuthStates(now);
      oauthStates.set(state, {
        name,
        env,
        oauthConfig,
        redirectUri,
        expires: now + OAUTH_TTL_MS,
      });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: oauthConfig.scopes.join(" "),
        state,
      });
      const authUrl = `${oauthConfig.authorization_url}?${params.toString()}`;
      return { authUrl };
    }
  );

  // OAuth callback — exchanges code for token, writes connection.yaml, starts MCP
  app.get(
    "/api/v1/integrations/:name/oauth/callback",
    {
      schema: {
        description:
          "OAuth callback handler. Exchanges the authorization code for an access token, writes connection.yaml, and starts the MCP server. Redirects to the integration detail page.",
        tags: ["integrations"],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            code: { type: "string" },
            state: { type: "string" },
            error: { type: "string" },
            error_description: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const query = req.query as {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };

      const webBase = process.env.PUBLIC_URL ?? "http://localhost:8080";

      if (query.error) {
        const msg = encodeURIComponent(query.error_description ?? query.error);
        return reply.redirect(`${webBase}/integrations/${name}?error=${msg}`);
      }

      const { code, state } = query;
      if (!code || !state) {
        return reply.redirect(
          `${webBase}/integrations/${name}?error=${encodeURIComponent("missing code or state")}`
        );
      }

      const stateEntry = oauthStates.get(state);
      if (!stateEntry || stateEntry.expires <= Date.now() || stateEntry.name !== name) {
        return reply.redirect(
          `${webBase}/integrations/${name}?error=${encodeURIComponent("invalid or expired state")}`
        );
      }
      oauthStates.delete(state);

      const { oauthConfig, env, redirectUri } = stateEntry;
      const clientId = env[oauthConfig.client_id_env] ?? "";
      const clientSecret = env[oauthConfig.client_secret_env] ?? "";

      // Exchange code for token via form-encoded POST
      let tokenData: Record<string, unknown>;
      try {
        const tokenRes = await fetch(oauthConfig.token_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
        });
        tokenData = (await tokenRes.json()) as Record<string, unknown>;
      } catch (e) {
        const msg = encodeURIComponent(
          `token exchange failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return reply.redirect(`${webBase}/integrations/${name}?error=${msg}`);
      }

      // Extract token via dot-path (default "access_token")
      const tokenPath = oauthConfig.token_response_path ?? "access_token";
      const token = tokenPath.split(".").reduce<unknown>((obj, key) => {
        return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
      }, tokenData);

      if (typeof token !== "string" || !token) {
        const msg = encodeURIComponent("token not found in OAuth response");
        return reply.redirect(`${webBase}/integrations/${name}?error=${msg}`);
      }

      // Merge token into env and write connection.yaml
      const mergedEnv = { ...env, [oauthConfig.token_env]: token };
      const connection = { enabled: true, env: mergedEnv };
      const connPath = join(gitSync.path, "integrations", name, "connection.yaml");
      try {
        await writeFile(connPath, toYaml(connection), "utf8");
        await gitSync.withSync(`soul: connect integration ${name} via OAuth`);
        await soulLoader.reload();
        const integration = soulLoader.integrations.get(name);
        if (integration) {
          await mcpClient.connect(name, integration.manifest, connection);
        }
      } catch (e) {
        const msg = encodeURIComponent(
          `connect failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return reply.redirect(`${webBase}/integrations/${name}?error=${msg}`);
      }

      return reply.redirect(`${webBase}/integrations/${name}?connected=true`);
    }
  );

  // Delete an integration from soul
  app.delete(
    "/api/v1/integrations/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove an integration from the soul repo (disconnects first if connected).",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      if (!NAME_RE.test(name) || !soulLoader.integrations.has(name)) {
        return reply.code(404).send({ error: `integration not found: ${name}` });
      }

      await mcpClient.disconnect(name);
      await rm(join(gitSync.path, "integrations", name), { recursive: true, force: true });

      const lock = await readIntegrationsLock(gitSync.path);
      delete lock.integrations[name];
      await writeIntegrationsLock(gitSync.path, lock);
      await gitSync.withSync(`soul: remove integration ${name}`);
      await soulLoader.reload();
      return reply.code(204).send();
    }
  );
}
