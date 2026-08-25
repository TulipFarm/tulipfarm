import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../published-loader";
import type { SkillScanFile } from "./guard";

/**
 * Where a Skill in the Soul came from. This is the only provenance vocabulary — every surface that
 * reports where a Skill came from reads it from `skills-lock.json` rather than deriving its own.
 *
 * - `bundled` — seeded from the app image by the boot sync; the instance does not own it.
 * - `marketplace` — installed from the official TulipFarm catalog.
 * - `public` — installed from any other source: a GitHub URL, a git remote, an archive.
 * - `curated` — authored in this instance through Chat or the UI.
 */
export const SKILL_SOURCE_TYPES = ["bundled", "marketplace", "public", "curated"] as const;
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];

/** Version recorded for a Skill whose `SKILL.md` declares none. */
export const DEFAULT_SKILL_VERSION = "1.0.0";

export const SKILLS_LOCK_FILE = "skills-lock.json";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OFFICIAL_MARKETPLACE_SOURCE = "tulipfarm/skills";
/** A GitHub remote in any spelling, including the bare `owner/repo` shorthand. */
const GITHUB_SOURCE_RE = /^(?:(?:https?:\/\/)?(?:[\w.-]+@)?github\.com[/:])?([\w.-]+\/[\w.-]+)$/;
const ORIGIN_RE = /^([A-Za-z][\w+.-]*:\/\/)?([^/]+)/;

export interface SkillLockEntry {
  readonly sourceType: SkillSourceType;
  /** The `version` from the Skill's own `SKILL.md`, so the lock records what is installed. */
  readonly version: string;
  readonly sourceUrl?: string;
  readonly skillPath?: string;
  readonly ref?: string;
  readonly hash?: string;
}

/** `version` is the lock file format; each entry carries the Skill's own version separately. */
export interface SkillsLock {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

export function marketplaceSource(): string {
  return process.env.MARKETPLACE_SOURCE ?? OFFICIAL_MARKETPLACE_SOURCE;
}

export function isSkillSourceType(value: unknown): value is SkillSourceType {
  return SKILL_SOURCE_TYPES.includes(value as SkillSourceType);
}

/**
 * Classify an install source. Only the configured catalog earns `marketplace`; everything else on
 * the internet is `public`, however it is spelled.
 */
export function installedSourceType(source: string): "marketplace" | "public" {
  return sameSource(source, marketplaceSource()) ? "marketplace" : "public";
}

function canonicalSource(source: string): string {
  // Strip the trailing slash first: `…/repo.git/` is the same remote as `…/repo`, but stripping
  // the suffix first leaves the `.git` stranded and the two spellings compare unequal.
  const base = (source.split("#", 1)[0] ?? "").replace(/\/+$/, "").replace(/\.git$/i, "");
  // GitHub is case-insensitive, so its paths fold. Any other host may serve two different
  // repositories whose paths differ only by case, so there only the scheme and origin fold —
  // folding the whole URL would hand one of them the other's provenance.
  const github = GITHUB_SOURCE_RE.exec(base);
  if (github?.[1] !== undefined) return github[1].toLowerCase();
  return base.replace(ORIGIN_RE, (_all, scheme: string | undefined, origin: string) => {
    return `${(scheme ?? "").toLowerCase()}${origin.toLowerCase()}`;
  });
}

function sameSource(left: string, right: string): boolean {
  return canonicalSource(left) === canonicalSource(right) && canonicalSource(left) !== "";
}

export function isSkillVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER_RE.test(value);
}

/** The declared version of a Skill, or the default when it declares none or declares nonsense. */
export function skillVersion(frontmatter: Record<string, unknown> | undefined): string {
  return isSkillVersion(frontmatter?.version) ? frontmatter.version : DEFAULT_SKILL_VERSION;
}

/** The declared version of a Skill package, read from the `SKILL.md` in its file list. */
export function skillVersionFromFiles(files: readonly SkillScanFile[]): string {
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return DEFAULT_SKILL_VERSION;
  try {
    return skillVersion(parseFrontmatter(skillMd.content).frontmatter);
  } catch {
    return DEFAULT_SKILL_VERSION;
  }
}

/**
 * Next patch version. Used when a Skill is edited without its author choosing a new version, so the
 * lock still distinguishes the stored Skill from the one that was there before.
 */
export function bumpPatch(version: string): string {
  const parsed = SEMVER_RE.exec(version);
  if (!parsed) return DEFAULT_SKILL_VERSION;
  return `${parsed[1]}.${parsed[2]}.${Number(parsed[3]) + 1}`;
}

/**
 * Coerce one persisted entry into the current vocabulary.
 *
 * Locks written before this vocabulary recorded git URL *shape* (`"github"` / `"git"`), which said
 * nothing about whether the Skill came from the official catalog. Reclassify from the recorded
 * source instead, and treat a sourceless entry as authored here.
 */
function normalizeEntry(raw: Record<string, unknown>): SkillLockEntry {
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined;
  const sourceType = isSkillSourceType(raw.sourceType)
    ? raw.sourceType
    : sourceUrl
      ? installedSourceType(sourceUrl)
      : "curated";
  return {
    sourceType,
    version: skillVersion(raw),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(typeof raw.skillPath === "string" ? { skillPath: raw.skillPath } : {}),
    ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}),
    ...(typeof raw.hash === "string" ? { hash: raw.hash } : {}),
  };
}

/**
 * Parse `skills-lock.json` content, normalized to the current vocabulary. Readers never see a
 * legacy `sourceType`; the boot sync is what persists the normalized form back to the Soul.
 * Absent or unparseable content reads as an empty lock, so a first boot is not a special case.
 */
export function parseSkillsLock(content: string | null): SkillsLock {
  let parsed: { version?: number; skills?: Record<string, Record<string, unknown>> };
  try {
    if (content === null) throw new Error("absent");
    parsed = JSON.parse(content);
  } catch {
    return { version: 1, skills: emptySkills() };
  }
  const skills = emptySkills();
  for (const [name, raw] of Object.entries(parsed.skills ?? {})) {
    if (raw !== null && typeof raw === "object") skills[name] = normalizeEntry(raw);
  }
  return { version: parsed.version ?? 1, skills };
}

/** {@link parseSkillsLock} over the Soul worktree's copy of the file. */
export async function readSkillsLock(soulPath: string): Promise<SkillsLock> {
  try {
    return parseSkillsLock(await readFile(join(soulPath, SKILLS_LOCK_FILE), "utf8"));
  } catch {
    return parseSkillsLock(null);
  }
}

/**
 * Skill names come from directory names, so they can collide with `Object.prototype` keys. A
 * prototype-less record keeps `lock.skills.constructor` absent rather than inherited — otherwise a
 * Skill named `constructor` reads as already-locked and never gets an entry, and one named
 * `__proto__` reassigns the record's prototype instead of storing anything.
 */
function emptySkills(): Record<string, SkillLockEntry> {
  return Object.create(null) as Record<string, SkillLockEntry>;
}

/** Serialize with a stable key order so an unchanged lock produces an unchanged file. */
export function serializeSkillsLock(lock: SkillsLock): string {
  const skills = emptySkills();
  for (const name of Object.keys(lock.skills).sort((left, right) => left.localeCompare(right))) {
    skills[name] = lock.skills[name];
  }
  return `${JSON.stringify({ version: lock.version, skills }, null, 2)}\n`;
}

export function sameLockEntry(left: SkillLockEntry, right: SkillLockEntry): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof SkillLockEntry>;
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}
