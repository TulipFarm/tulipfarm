import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { LlmService } from "@tulipfarm/llm";
import type { GitSyncService, SoulLoader, SoulSkill } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { ErrorSchema } from "../../auth/schemas";
import { SKILL_AUDIT_REPORT_SCHEMA, buildAudit } from "./audit";

/*
 * Skills HTTP surface (SKILLS / SKL-V1-001..003). Read endpoints over the SoulLoader, plus the
 * install-from-git flow:
 *   scan  → clone a git repo to a temp dir and discover installable SKILL.md files,
 *   audit → run the advisory SkillAudit LLM review on one discovered skill,
 *   install → (operator confirm) write the chosen skills into the soul repo + skills-lock.json.
 * The audit is ADVISORY: the server never auto-installs on scan/audit — install is a separate,
 * explicit operator action.
 */

const execFileP = promisify(execFile);

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCAN_TTL_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 60_000;
const MAX_SCANS = 25;

export interface DiscoveredSkill {
  name: string;
  description?: string;
  // Path of the SKILL.md relative to the repo root (recorded in skills-lock.json).
  skillPath: string;
  // Raw SKILL.md content (frontmatter + body), written verbatim on install.
  content: string;
}

interface ScanEntry {
  source: string;
  skills: DiscoveredSkill[];
  // Names that have been through SkillAudit — install is gated on this (AC-V1-003).
  audited: Set<string>;
  expires: number;
}

// In-memory scan cache so audit/install reuse the cloned content instead of re-cloning. Single-process
// only (V1). Entries expire after SCAN_TTL_MS and are pruned lazily on each scan.
const scans = new Map<string, ScanEntry>();

function pruneScans(now: number): void {
  for (const [id, entry] of scans) {
    if (entry.expires <= now) scans.delete(id);
  }
  // Bound memory: drop the oldest entries beyond the cap (Map preserves insertion order).
  while (scans.size > MAX_SCANS) {
    const oldest = scans.keys().next().value;
    if (oldest === undefined) break;
    scans.delete(oldest);
  }
}

// Fetch a scan entry only if it hasn't passed its TTL. pruneScans runs only on new scans,
// so without this an expired scanId stays usable for audit/install until an unrelated scan
// happens to prune it — this enforces the documented TTL on every consumer.
function liveScan(scanId: string, now: number): ScanEntry | undefined {
  const entry = scans.get(scanId);
  if (!entry) return undefined;
  if (entry.expires <= now) {
    scans.delete(scanId);
    return undefined;
  }
  return entry;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  return { frontmatter, body: match[2].trim() };
}

// Only allow sources we are willing to hand to `git clone`: a bare "owner/repo" slug, or an
// http(s) URL. ssh:// and scp-style (git@host:path) sources are rejected to avoid the operator's
// clone reaching internal hosts. `file://` lets an authenticated operator read any local git repo
// on the server host, so it is disabled by default and gated behind an explicit dev opt-in.
// (http(s) SSRF to internal hosts remains a single-trust V1 risk; a host allowlist is post-V1.)
function isAllowedSource(source: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(source) || /^https?:\/\//.test(source)) return true;
  if (/^file:\/\//.test(source)) return process.env.TF_ALLOW_LOCAL_SKILL_SOURCES === "1";
  return false;
}

// Normalize an allowed source into something `git clone` accepts. A bare "owner/repo" becomes a
// GitHub https URL; an http(s)/file URL is used as-is.
function normalizeGitUrl(source: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return `https://github.com/${source}.git`;
  return source;
}

function sourceType(source: string): "github" | "git" {
  return /github\.com|^[\w.-]+\/[\w.-]+$/.test(source) ? "github" : "git";
}

/**
 * Walk a directory tree for SKILL.md files and parse each into a DiscoveredSkill. Skips .git and
 * node_modules. Skills whose resolved name is not a safe kebab-case identifier are dropped (the name
 * becomes a soul directory on install, so it must not allow path traversal). Exported for testing.
 */
export async function discoverSkills(root: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name === "SKILL.md") {
        const content = await readFile(full, "utf8");
        const { frontmatter } = parseFrontmatter(content);
        const name = asString(frontmatter.name) ?? basename(dirname(full));
        if (!NAME_RE.test(name)) continue;
        out.push({
          name,
          description: asString(frontmatter.description),
          skillPath: relative(root, full),
          content,
        });
      }
    }
  }
  await walk(root, 0);
  return out;
}

async function cloneToTemp(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-scan-"));
  await execFileP("git", ["clone", "--depth", "1", normalizeGitUrl(source), dir], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return dir;
}

async function readLock(soulPath: string): Promise<{
  version: number;
  skills: Record<
    string,
    { source?: string; sourceType?: string; skillPath?: string; computedHash?: string }
  >;
}> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8")) as {
      version?: number;
      skills?: Record<
        string,
        { source?: string; sourceType?: string; skillPath?: string; computedHash?: string }
      >;
    };
    // A freshly-initialized lock may be `{}` (no `skills` key) — normalize so callers can always
    // index `lock.skills`.
    return { version: parsed.version ?? 1, skills: parsed.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function toSkillSummary(
  skill: SoulSkill,
  lock: Awaited<ReturnType<typeof readLock>>
): {
  name: string;
  description?: string;
  provenance: "builtin" | "marketplace" | "user";
  source?: string;
} {
  const locked = lock.skills[skill.name];
  return {
    name: skill.name,
    description: asString(skill.frontmatter.description),
    provenance: locked ? "marketplace" : "user",
    source: locked?.source,
  };
}

const SummaryProps = {
  name: { type: "string" },
  description: { type: "string" },
  provenance: { type: "string", enum: ["builtin", "marketplace", "user"] },
  source: { type: "string" },
} as const;

export function registerSkillRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  llmService: LlmService,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/skills",
    {
      preHandler: requireAuth,
      schema: {
        description: "List skills installed in the soul repo, with provenance.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: {
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "provenance"],
                  properties: SummaryProps,
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const lock = await readLock(gitSync.path);
      const skills = Array.from(soulLoader.skills.values()).map((s) => toSkillSummary(s, lock));
      return { skills };
    }
  );

  app.get(
    "/api/v1/skills/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single skill including its SKILL.md markdown body.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["name", "provenance", "body"],
            properties: { ...SummaryProps, body: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const skill = soulLoader.skills.get(name);
      if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
      const lock = await readLock(gitSync.path);
      return { ...toSkillSummary(skill, lock), body: skill.body };
    }
  );

  app.post(
    "/api/v1/skills/scan",
    {
      preHandler: requireAuth,
      schema: {
        description: "Clone a git repo and discover installable SKILL.md files.",
        tags: ["skills"],
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
            required: ["scanId", "skills"],
            properties: {
              scanId: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" }, description: { type: "string" } },
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
        return reply
          .code(400)
          .send({ error: "source must be a github owner/repo slug or an http(s)/file URL" });
      }
      let dir: string | undefined;
      try {
        dir = await cloneToTemp(source);
        const discovered = await discoverSkills(dir);
        if (discovered.length === 0) {
          return reply.code(400).send({ error: "no SKILL.md files found in repo" });
        }
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, {
          source,
          skills: discovered,
          audited: new Set(),
          expires: Date.now() + SCAN_TTL_MS,
        });
        return {
          scanId,
          skills: discovered.map((s) => ({ name: s.name, description: s.description })),
        };
      } catch (e) {
        return reply
          .code(400)
          .send({ error: `scan failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }
  );

  app.post(
    "/api/v1/skills/audit",
    {
      preHandler: requireAuth,
      schema: {
        description: "Run the advisory SkillAudit review on a scanned skill.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["scanId", "name"],
          additionalProperties: false,
          properties: { scanId: { type: "string" }, name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["report"],
            properties: { report: SKILL_AUDIT_REPORT_SCHEMA },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, name } = req.body as { scanId: string; name: string };
      const entry = liveScan(scanId, Date.now());
      const skill = entry?.skills.find((s) => s.name === name);
      if (!entry || !skill)
        return reply.code(404).send({ error: "scanned skill not found (scan may have expired)" });
      const { body } = parseFrontmatter(skill.content);
      const report = await buildAudit(llmService.select({ model: "standard" }), {
        name: skill.name,
        description: skill.description,
        body,
      });
      // Record that the operator has seen an audit for this skill; install is gated on it.
      entry.audited.add(name);
      return { report };
    }
  );

  app.post(
    "/api/v1/skills/install",
    {
      preHandler: requireAuth,
      schema: {
        description: "Operator confirm: install the named scanned skills into the soul repo.",
        tags: ["skills"],
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
            properties: {
              installed: { type: "array", items: { type: "string" } },
              pushed: { type: "boolean" },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, names } = req.body as { scanId: string; names: string[] };
      const entry = liveScan(scanId, Date.now());
      if (!entry) return reply.code(404).send({ error: "scan not found (it may have expired)" });

      const unique = [...new Set(names)];
      const chosen = unique.map((n) => entry.skills.find((s) => s.name === n));
      const missing = unique.filter((_, i) => !chosen[i]);
      if (missing.length > 0)
        return reply.code(400).send({ error: `not in scan: ${missing.join(", ")}` });

      // Operator must have run SkillAudit on each skill before it can be installed (AC-V1-003). The
      // rating itself never blocks — only the act of auditing is required.
      const unaudited = unique.filter((n) => !entry.audited.has(n));
      if (unaudited.length > 0)
        return reply
          .code(409)
          .send({ error: `audit required before install: ${unaudited.join(", ")}` });

      // Snapshot what we touch so a commit/reload failure rolls back cleanly instead of
      // leaving half-installed skills that load on next boot. We only delete skill dirs we
      // newly created (never an existing one we'd be re-installing over) and restore the
      // prior lock file verbatim.
      const lockPath = join(gitSync.path, "skills-lock.json");
      const priorLock = await readFile(lockPath, "utf8").catch(() => null);
      const createdDirs: string[] = [];

      const installed: string[] = [];
      for (const skill of chosen as DiscoveredSkill[]) {
        const dir = join(gitSync.path, "skills", skill.name);
        const existed = await stat(dir).then(
          () => true,
          () => false
        );
        await mkdir(dir, { recursive: true });
        if (!existed) createdDirs.push(dir);
        await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
        installed.push(skill.name);
      }

      // Record provenance in skills-lock.json, then commit both SKILL.md files and the lock together.
      const lock = await readLock(gitSync.path);
      for (const skill of chosen as DiscoveredSkill[]) {
        lock.skills[skill.name] = {
          source: entry.source,
          sourceType: sourceType(entry.source),
          skillPath: skill.skillPath,
          computedHash: createHash("sha256").update(skill.content).digest("hex"),
        };
      }
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

      try {
        const sync = await gitSync.withSync(`soul: install skill(s) ${installed.join(", ")}`);
        await soulLoader.reload();
        // `pushed` lets the UI distinguish a durable install from one committed locally that a
        // later sync may hard-reset away (SOUL-V1-004). undefined in local-only mode.
        return { installed, pushed: sync.pushed };
      } catch (e) {
        await Promise.all(createdDirs.map((d) => rm(d, { recursive: true, force: true })));
        if (priorLock === null) await rm(lockPath, { force: true });
        else await writeFile(lockPath, priorLock, "utf8");
        app.log.error(`skills: install failed, rolled back — ${String(e)}`);
        return reply.code(500).send({ error: "install failed" });
      }
    }
  );
}
