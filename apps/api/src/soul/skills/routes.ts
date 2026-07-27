import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { LlmService } from "@tulipfarm/llm";
import { LlmNotConfiguredError, validateSkill } from "@tulipfarm/schema";
import {
  type GitSyncService,
  parseFrontmatter,
  type SoulLoader,
  type SoulSkill,
} from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ActivityService } from "../../activity/service";
import { ErrorSchema } from "../../auth/schemas";
import { buildAudit, SKILL_AUDIT_REPORT_SCHEMA } from "./audit";
import { type BundledSkill, persistDisabledBundledSkills } from "./bundled";
import { mergedSkills, resolveSkill } from "./registry";

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

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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
  // HEAD commit sha of the cloned repo at scan time — recorded as `ref` in skills-lock.json.
  ref: string;
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// A source may carry an optional "#<ref>" suffix (branch or tag name — not a commit SHA) so
// pre-merge branches can be scanned and tested: "owner/repo#my-branch". No "#" ⇒ default branch.
function splitSourceRef(source: string): { base: string; ref?: string } {
  const idx = source.indexOf("#");
  return idx === -1 ? { base: source } : { base: source.slice(0, idx), ref: source.slice(idx + 1) };
}

// Leading dash forbidden so a ref can never be mistaken for a git flag.
const REF_RE = /^[\w][\w./-]*$/;

// Only allow sources we are willing to hand to `git clone`: a bare "owner/repo" slug, or an
// http(s)/file URL, each with an optional "#<ref>" suffix. ssh:// and scp-style (git@host:path)
// sources are rejected to avoid the operator's clone reaching internal hosts (SSRF). Single-trust
// V1; a tighter allowlist is a post-V1 hardening.
function isAllowedSource(source: string): boolean {
  const { base, ref } = splitSourceRef(source);
  if (ref !== undefined && !REF_RE.test(ref)) return false;
  return /^[\w.-]+\/[\w.-]+$/.test(base) || /^(https?|file):\/\//.test(base);
}

// Normalize an allowed source (ref already split off) into something `git clone` accepts. A bare
// "owner/repo" becomes a GitHub https URL; an http(s)/file URL is used as-is.
function normalizeGitUrl(base: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(base)) return `https://github.com/${base}.git`;
  return base;
}

function sourceType(source: string): "github" | "git" {
  const { base } = splitSourceRef(source);
  return /github\.com|^[\w.-]+\/[\w.-]+$/.test(base) ? "github" : "git";
}

/**
 * Walk a directory tree for SKILL.md files and parse each into a DiscoveredSkill. Skips .git and
 * node_modules. Skills whose directory name is not a safe Skill identifier are dropped (that name
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
        const name = basename(dirname(full));
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

async function cloneToTemp(source: string): Promise<{ dir: string; ref: string }> {
  const { base, ref } = splitSourceRef(source);
  const dir = await mkdtemp(join(tmpdir(), "skill-scan-"));
  // --branch accepts branch or tag names (not commit SHAs) and still works with --depth 1.
  await execFileP(
    "git",
    ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), normalizeGitUrl(base), dir],
    {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }
  );
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, ref: stdout.trim() };
}

// Per-skill lock entries follow spec SKL-V1-001: provenance is (sourceUrl, ref, hash), plus
// sourceType and skillPath for the audit trail.
interface LockEntry {
  sourceUrl?: string;
  sourceType?: string;
  skillPath?: string;
  ref?: string;
  hash?: string;
}

async function readLock(soulPath: string): Promise<{
  version: number;
  skills: Record<string, LockEntry>;
}> {
  try {
    const parsed = JSON.parse(await readFile(join(soulPath, "skills-lock.json"), "utf8")) as {
      version?: number;
      skills?: Record<string, LockEntry>;
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
  lock: Awaited<ReturnType<typeof readLock>>,
  bundledOnly = false
): {
  name: string;
  description?: string;
  provenance: "builtin" | "marketplace" | "user";
  source?: string;
  pendingAudit: boolean;
} {
  const locked = lock.skills[skill.name];
  return {
    name: skill.name,
    description: asString(skill.frontmatter.description),
    provenance: bundledOnly ? "builtin" : locked ? "marketplace" : "user",
    source: locked?.sourceUrl,
    pendingAudit: skill.frontmatter._pendingAudit === true,
  };
}

// Cross-reference a discovered skill against what is installed: `installed` is true when the soul
// repo already holds it, `updateAvailable` when its lock hash (sha256 of the installed SKILL.md,
// recorded on install) differs from the freshly-cloned content. User-authored skills have no lock
// hash, so update status is unknowable for them and reported as false.
function installStatus(
  skill: DiscoveredSkill,
  lock: Awaited<ReturnType<typeof readLock>>,
  soulLoader: SoulLoader,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
): { installed: boolean; updateAvailable: boolean } {
  const installed = mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).has(skill.name);
  const lockedHash = lock.skills[skill.name]?.hash;
  const updateAvailable =
    installed &&
    !!lockedHash &&
    lockedHash !== createHash("sha256").update(skill.content).digest("hex");
  return { installed, updateAvailable };
}

// Curated-catalog manifest at the marketplace repo root (skills.sh shape). Discovery stays
// authoritative — the manifest only enriches discovered skills; entries without a SKILL.md on
// disk are ignored.
interface MarketplaceManifestEntry {
  skillId?: string;
  name?: string;
  description?: string;
  installs?: number;
}

// Read at request time (not module load) so the env override is honored per-request and in tests.
function marketplaceSource(): string {
  return process.env.MARKETPLACE_SOURCE ?? "tulipfarm/skills";
}

interface MarketplaceResponse {
  scanId: string;
  source: string;
  skills: {
    name: string;
    skillId?: string;
    description?: string;
    installs?: number;
    installed: boolean;
    updateAvailable: boolean;
  }[];
}

// Keyed by source so an env change never serves a stale catalog. Entries are only valid while the
// matching scan entry is still alive (pruning/cap can evict it independently).
const marketplaceCache = new Map<
  string,
  { scanId: string; expires: number; response: MarketplaceResponse }
>();

async function readManifest(dir: string): Promise<Map<string, MarketplaceManifestEntry>> {
  const byName = new Map<string, MarketplaceManifestEntry>();
  try {
    const parsed = JSON.parse(await readFile(join(dir, "marketplace.json"), "utf8")) as {
      skills?: MarketplaceManifestEntry[];
    };
    for (const entry of Array.isArray(parsed.skills) ? parsed.skills : []) {
      // Index under both skillId and name — the lookup key is the DISCOVERED skill's frontmatter
      // name, which manifest authors may have recorded in either field.
      for (const key of [asString(entry.skillId), asString(entry.name)]) {
        if (key && !byName.has(key)) byName.set(key, entry);
      }
    }
  } catch {
    // Missing or invalid manifest is fine — the catalog is just the bare discovered list.
  }
  return byName;
}

const SummaryProps = {
  name: { type: "string" },
  description: { type: "string" },
  provenance: { type: "string", enum: ["builtin", "marketplace", "user"] },
  source: { type: "string" },
  pendingAudit: { type: "boolean" },
} as const;

export function registerSkillRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  gitSync: GitSyncService,
  llmService: LlmService,
  requireAuth: PreHandler,
  // Optional: record skill installs in the activity feed.
  activity?: ActivityService,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: Set<string> = new Set()
): void {
  app.get(
    "/api/v1/skills",
    {
      preHandler: requireAuth,
      schema: {
        description: "List Soul and bundled Skills with provenance.",
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
                  required: ["name", "provenance", "pendingAudit"],
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
      const skills = Array.from(
        mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values()
      ).map((skill) => toSkillSummary(skill, lock, !soulLoader.skills.has(skill.name)));
      return { skills };
    }
  );

  app.get(
    "/api/v1/skills/marketplace",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Browse the official skills marketplace (TulipFarm/skills). Returns a scanId usable with the audit and install endpoints.",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["scanId", "source", "skills"],
            properties: {
              scanId: { type: "string" },
              source: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "installed", "updateAvailable"],
                  properties: {
                    name: { type: "string" },
                    skillId: { type: "string" },
                    description: { type: "string" },
                    installs: { type: "number" },
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
      // The catalog clone creates server-side scan state, so never let intermediaries cache it.
      reply.header("cache-control", "no-store");
      const source = marketplaceSource();
      const now = Date.now();
      const cached = marketplaceCache.get(source);
      if (cached && cached.expires > now && scans.has(cached.scanId)) return cached.response;

      let dir: string | undefined;
      try {
        const clone = await cloneToTemp(source);
        dir = clone.dir;
        const discovered = await discoverSkills(dir);
        const manifest = await readManifest(dir);
        const lock = await readLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(now);
        // A real scan entry so the existing audit → operator-confirm install flow (and its 409
        // audit gate, AC-V1-003) applies to marketplace installs unchanged.
        scans.set(scanId, {
          source,
          ref: clone.ref,
          skills: discovered,
          audited: new Set(),
          expires: now + SCAN_TTL_MS,
        });
        const response: MarketplaceResponse = {
          scanId,
          source,
          skills: discovered.map((s) => {
            const meta = manifest.get(s.name);
            return {
              name: s.name,
              skillId: asString(meta?.skillId),
              description: s.description ?? asString(meta?.description),
              installs: typeof meta?.installs === "number" ? meta.installs : undefined,
              ...installStatus(s, lock, soulLoader, bundledSkills, disabledBundledSkills),
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
            required: ["name", "provenance", "body", "pendingAudit"],
            properties: { ...SummaryProps, body: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const skill = resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills);
      if (!skill) return reply.code(404).send({ error: `skill not found: ${name}` });
      const lock = await readLock(gitSync.path);
      return {
        ...toSkillSummary(skill, lock, !soulLoader.skills.has(name)),
        body: skill.body,
      };
    }
  );

  app.delete(
    "/api/v1/skills/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove an installed skill from the soul repo (and its skills-lock entry).",
        tags: ["skills"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        response: { 204: { type: "null" }, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      // NAME_RE also guards the rm path below against traversal, same as install.
      if (
        !NAME_RE.test(name) ||
        !resolveSkill(name, soulLoader, bundledSkills, disabledBundledSkills)
      ) {
        return reply.code(404).send({ error: `skill not found: ${name}` });
      }
      if (soulLoader.skills.has(name)) {
        await rm(join(gitSync.path, "skills", name), { recursive: true, force: true });
      }
      if (bundledSkills.has(name)) {
        disabledBundledSkills.add(name);
        await persistDisabledBundledSkills(gitSync.path, disabledBundledSkills);
      }
      const lock = await readLock(gitSync.path);
      delete lock.skills[name];
      await writeFile(
        join(gitSync.path, "skills-lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
        "utf8"
      );
      await gitSync.withSync(`soul: remove skill ${name}`);
      await soulLoader.reload();
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/v1/skills/scan",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Clone a git repo (source accepts an optional #branch suffix) and discover installable SKILL.md files.",
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
                  required: ["name", "installed", "updateAvailable"],
                  properties: {
                    name: { type: "string" },
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
          error:
            "source must be a github owner/repo slug or an http(s)/file URL, with an optional #branch suffix",
        });
      }
      let dir: string | undefined;
      try {
        const clone = await cloneToTemp(source);
        dir = clone.dir;
        const discovered = await discoverSkills(dir);
        if (discovered.length === 0) {
          return reply.code(400).send({ error: "no SKILL.md files found in repo" });
        }
        const lock = await readLock(gitSync.path);
        const scanId = randomUUID();
        pruneScans(Date.now());
        scans.set(scanId, {
          source,
          ref: clone.ref,
          skills: discovered,
          audited: new Set(),
          expires: Date.now() + SCAN_TTL_MS,
        });
        return {
          scanId,
          skills: discovered.map((s) => ({
            name: s.name,
            description: s.description,
            ...installStatus(s, lock, soulLoader, bundledSkills, disabledBundledSkills),
          })),
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
          422: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, name } = req.body as { scanId: string; name: string };
      const entry = scans.get(scanId);
      const skill = entry?.skills.find((s) => s.name === name);
      if (!entry || !skill)
        return reply.code(404).send({ error: "scanned skill not found (scan may have expired)" });
      const { body } = parseFrontmatter(skill.content);
      let report: Awaited<ReturnType<typeof buildAudit>>;
      try {
        report = await buildAudit(llmService.select({ model: "standard" }), {
          name: skill.name,
          description: skill.description,
          body,
        });
      } catch (e) {
        // SkillAudit needs a working LLM. Surface an actionable message instead of a bare 500: a
        // missing provider is a config problem (422), any other failure is an upstream error (502).
        if (e instanceof LlmNotConfiguredError) {
          return reply.code(422).send({
            error: "SkillAudit needs an LLM provider — configure one in Settings → LLM.",
          });
        }
        return reply
          .code(502)
          .send({ error: `SkillAudit failed: ${e instanceof Error ? e.message : String(e)}` });
      }
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
            properties: { installed: { type: "array", items: { type: "string" } } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { scanId, names } = req.body as { scanId: string; names: string[] };
      const entry = scans.get(scanId);
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

      for (const skill of chosen as DiscoveredSkill[]) {
        const { frontmatter, body } = parseFrontmatter(skill.content);
        const validation = validateSkill({
          name: skill.name,
          frontmatter,
          body,
          content: skill.content,
        });
        if (!validation.valid) {
          return reply
            .code(400)
            .send({ error: `invalid Skill "${skill.name}": ${validation.error}` });
        }
      }

      const installed: string[] = [];
      for (const skill of chosen as DiscoveredSkill[]) {
        const dir = join(gitSync.path, "skills", skill.name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
        installed.push(skill.name);
      }

      // Record provenance in skills-lock.json, then commit both SKILL.md files and the lock together.
      const lock = await readLock(gitSync.path);
      for (const skill of chosen as DiscoveredSkill[]) {
        lock.skills[skill.name] = {
          sourceUrl: entry.source,
          sourceType: sourceType(entry.source),
          skillPath: skill.skillPath,
          ref: entry.ref,
          hash: createHash("sha256").update(skill.content).digest("hex"),
        };
      }
      await writeFile(
        join(gitSync.path, "skills-lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
        "utf8"
      );

      await gitSync.withSync(`soul: install skill(s) ${installed.join(", ")}`);
      await soulLoader.reload();
      await activity?.record({
        category: "skill",
        action: "skill.installed",
        actorId: (req.user as { _id: string } | undefined)?._id,
        targetType: "skill",
        targetId: installed.join(", "),
        summary: `Installed skill(s): ${installed.join(", ")}`,
        metadata: { skills: installed, source: entry.source, ref: entry.ref },
      });
      return { installed };
    }
  );
}
