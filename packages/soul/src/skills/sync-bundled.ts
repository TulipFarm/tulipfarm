import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { CommitActor } from "../commit-signing";
import { artifactWriteTarget, type SoulWrite, type SoulWriter } from "../writer";
import type { BundledSkill } from "./bundled";
import { expandForgeExecutionContract } from "./forge-execution-contract";
import type { SkillScanFile } from "./guard";
import {
  type SkillLockEntry,
  sameLockEntry,
  serializeSkillsLock,
  skillVersionFromFiles,
} from "./lock";
import { mutateSkillsLock } from "./lock-write";
import { collectSkillFiles, skillDirectoryHash } from "./marketplace-files";

interface SyncLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface BundledSkillSyncResult {
  /** Shipped Skills that had no Soul directory and were written for the first time. */
  readonly installed: readonly string[];
  /** Soul copies that still matched their lock hash and were refreshed from the newer image. */
  readonly updated: readonly string[];
  /** Soul copies of Skills the image no longer ships, deleted because they were never edited. */
  readonly removed: readonly string[];
  /** Soul copies left untouched because they drifted from the lock hash or are not ours. */
  readonly customized: readonly string[];
  /** Shipped Skills the operator switched off; never re-seeded. */
  readonly skipped: readonly string[];
  /** Soul Skills that had no lock entry and were recorded as `curated`. */
  readonly recorded: readonly string[];
}

export interface BundledSkillSyncInput {
  readonly soulPath: string;
  readonly bundledSkills: ReadonlyMap<string, BundledSkill>;
  readonly disabledBundledSkills: ReadonlySet<string>;
  readonly soulWriter: SoulWriter;
  readonly actor: CommitActor;
  readonly logger: SyncLogger;
  readonly businessId?: string;
}

/**
 * Copy every shipped Skill into the authored Soul tree so it is a real, git-tracked artifact rather
 * than a process-local overlay — visible in the Soul repo, editable through the product, and part
 * of the signed runtime bundle.
 *
 * Ownership is tracked in `skills-lock.json` under `sourceType: "bundled"`. A Soul copy is only
 * rewritten while its content still hashes to the locked value, so an operator or Agent edit
 * survives every later boot; the image simply stops updating that Skill.
 *
 * This is also where the lock is reconciled with the Soul as a whole: every Skill on disk ends up
 * with an entry, and entries written under the pre-`SkillSourceType` vocabulary are rewritten in
 * the current one.
 */
export async function syncBundledSkillsIntoSoul(
  input: BundledSkillSyncInput
): Promise<BundledSkillSyncResult> {
  let outcome: BundledSkillSyncResult = {
    installed: [],
    updated: [],
    removed: [],
    customized: [],
    skipped: [],
    recorded: [],
  };
  let committed = false;

  // The whole plan is recomputed inside the mutation, because a lock that changed under us
  // invalidates every ownership decision below, not just the entry that moved.
  await mutateSkillsLock(input.soulWriter, input.soulPath, async (stored, raw) => {
    committed = false;
    const installed: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const customized: string[] = [];
    const skipped: string[] = [];
    const recorded: string[] = [];
    const changes: SoulWrite[] = [];
    const lock = { version: stored.version, skills: { ...stored.skills } };
    // The lock is normalized on the way in, so a difference here is a migration not yet persisted.
    let lockChanged = serializeSkillsLock(lock) !== raw;

    const names = [...input.bundledSkills.keys()].sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const skill = input.bundledSkills.get(name);
      if (skill === undefined) continue;
      if (input.disabledBundledSkills.has(name)) {
        skipped.push(name);
        continue;
      }

      let desired: SkillScanFile[];
      try {
        desired = await readBundledPackage(skill);
      } catch (error) {
        input.logger.error(
          `Bundled Skills: cannot read "${name}" to seed the Soul: ${reason(error)}`
        );
        continue;
      }
      const desiredHash = skillDirectoryHash(desired);
      const existing = await readSoulPackage(input.soulPath, name);

      if (existing === undefined) {
        changes.push(...packageWrites(name, desired, []));
        lock.skills[name] = bundledLockEntry(skill, desired, desiredHash);
        lockChanged = true;
        installed.push(name);
        continue;
      }

      const locked = lock.skills[name];
      if (locked?.sourceType !== "bundled") {
        customized.push(name);
        continue;
      }
      const existingHash = skillDirectoryHash(existing);
      if (existingHash === desiredHash) {
        // The package is current, but the lock entry's own shape may not be — refresh a stale one so
        // a change to what we record reaches Souls seeded by an older build.
        const fresh = bundledLockEntry(skill, desired, desiredHash);
        if (!sameLockEntry(locked, fresh)) {
          lock.skills[name] = fresh;
          lockChanged = true;
        }
        continue;
      }
      if (existingHash !== locked.hash) {
        // Edited outside our tooling — a direct commit to the Soul repo, since `skill_update` rewrites
        // the entry itself. The business owns it now, so say so: leaving the entry `bundled` makes
        // every surface keep crediting the image for the operator's work, and every boot rediscover
        // the same edit without ever recording it.
        lock.skills[name] = { sourceType: "curated", version: skillVersionFromFiles(existing) };
        lockChanged = true;
        customized.push(name);
        continue;
      }
      changes.push(...packageWrites(name, desired, existing));
      lock.skills[name] = bundledLockEntry(skill, desired, desiredHash);
      lockChanged = true;
      updated.push(name);
    }

    // A Skill dropped from the image must not live on forever in every Soul that was ever seeded.
    // The lock is this seeder's ownership record, so it alone decides what may be reaped.
    for (const name of Object.keys(lock.skills).sort((left, right) => left.localeCompare(right))) {
      const locked = lock.skills[name];
      if (locked.sourceType !== "bundled") continue;
      if (input.bundledSkills.has(name)) continue;
      const existing = await readSoulPackage(input.soulPath, name);
      delete lock.skills[name];
      lockChanged = true;
      if (existing === undefined) continue;
      if (skillDirectoryHash(existing) !== locked.hash) {
        // Edited after seeding, so the business owns it now: disown it rather than delete their work.
        customized.push(name);
        continue;
      }
      changes.push({ op: "deleteArtifact", kind: "Skill", slug: name });
      removed.push(name);
    }

    // Everything left on disk without an entry was authored here — through Chat or the UI, which
    // write only SKILL.md. Record it so the lock is a complete inventory rather than a list of
    // things that came from elsewhere. A curated entry carries no hash: there is no upstream to
    // drift from, and git history is already the record of what changed.
    //
    // A Skill reaped above is excluded: its directory is still on disk until this changeset is
    // applied, and recording it would resurrect as `curated` the very entry we just dropped. A
    // *disowned* one is not excluded, because it genuinely is the business's own Skill now.
    const reaped = new Set(removed);
    for (const name of await soulSkillNames(input.soulPath)) {
      if (lock.skills[name] !== undefined || reaped.has(name)) continue;
      const files = await readSoulPackage(input.soulPath, name);
      if (files === undefined) continue;
      lock.skills[name] = { sourceType: "curated", version: skillVersionFromFiles(files) };
      lockChanged = true;
      recorded.push(name);
    }

    outcome = { installed, updated, removed, customized, skipped, recorded };
    if (!lockChanged) return null;
    changes.push({
      op: "put",
      target: { kind: "SkillsLock" },
      content: serializeSkillsLock(lock),
    });
    committed = true;
    return {
      subject: syncSubject(installed, updated, removed),
      source: "api",
      actor: input.actor,
      businessId: input.businessId ?? DEPLOYMENT_BUSINESS_ID,
      changes,
    };
  });

  if (committed) {
    input.logger.info(
      `Bundled Skills: seeded ${outcome.installed.length}, refreshed ${outcome.updated.length} and removed ${outcome.removed.length} Soul Skill(s)`
    );
  }
  if (outcome.recorded.length > 0) {
    input.logger.info(
      `Bundled Skills: recorded ${outcome.recorded.length} curated Soul Skill(s) in the lock: ${outcome.recorded.join(", ")}`
    );
  }
  if (outcome.customized.length > 0) {
    input.logger.info(
      `Bundled Skills: left ${outcome.customized.length} locally modified Soul Skill(s) untouched: ${outcome.customized.join(", ")}`
    );
  }
  return outcome;
}

function syncSubject(
  installed: readonly string[],
  updated: readonly string[],
  removed: readonly string[]
): string {
  const touched = [...installed, ...updated, ...removed];
  return touched.length === 0
    ? "soul: sync built-in skill lock"
    : `soul: sync built-in skill(s) ${touched.join(", ")}`;
}

/**
 * The shipped package exactly as the Soul should hold it. `SKILL.md` is expanded here because the
 * Soul loader does not run the forge-contract expansion — an unexpanded copy would ship the raw
 * token to the model.
 */
async function readBundledPackage(skill: BundledSkill): Promise<SkillScanFile[]> {
  const files = await collectSkillFiles(skill.directory);
  return files
    .filter((file) => file.symlinkTarget === undefined)
    .map((file) => {
      if (file.path !== "SKILL.md") return file;
      const content = expandForgeExecutionContract(file.content);
      return { ...file, content, size: Buffer.byteLength(content) };
    });
}

async function readSoulPackage(
  soulPath: string,
  name: string
): Promise<SkillScanFile[] | undefined> {
  try {
    return await collectSkillFiles(join(soulPath, "skills", name));
  } catch {
    return undefined;
  }
}

/** Write every shipped file and delete whatever the previous copy had that this one does not. */
function packageWrites(
  name: string,
  desired: readonly SkillScanFile[],
  existing: readonly SkillScanFile[]
): SoulWrite[] {
  const written = new Set(desired.map((file) => file.path));
  const writes: SoulWrite[] = desired.map((file) => ({
    op: "put",
    target: artifactWriteTarget("Skill", name, file.path),
    content: file.content,
  }));
  for (const file of existing) {
    if (written.has(file.path)) continue;
    writes.push({ op: "delete", target: artifactWriteTarget("Skill", name, file.path) });
  }
  return writes;
}

function bundledLockEntry(
  skill: BundledSkill,
  files: readonly SkillScanFile[],
  hash: string
): SkillLockEntry {
  return {
    sourceType: "bundled",
    version: skillVersionFromFiles(files),
    skillPath: skill.name,
    hash,
  };
}

/** Directory names under `skills/`, which is the Soul's own record of what it holds. */
async function soulSkillNames(soulPath: string): Promise<string[]> {
  try {
    const entries = await readdir(join(soulPath, "skills"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
