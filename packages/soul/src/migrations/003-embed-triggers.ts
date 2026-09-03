import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SoulMigration } from "./index";

const TRIGGERS_DIR = "triggers";
const ROUTINES_DIR = "routines";

interface LegacyTrigger {
  readonly slug: string;
  readonly routineSlug: string;
  readonly spec: Record<string, unknown>;
}

/** Read one `triggers/<slug>/trigger.yaml`, or refuse a shape this migration cannot fold. */
async function readLegacyTrigger(directory: string, slug: string): Promise<LegacyTrigger> {
  const document = parseYaml(await readFile(join(directory, slug, "trigger.yaml"), "utf8"));
  if (!isRecord(document) || document.kind !== "Trigger" || !isRecord(document.spec)) {
    throw new Error(`triggers/${slug}/trigger.yaml is not a Trigger document`);
  }
  const { routineRef, ...spec } = document.spec;
  if (!isRecord(routineRef) || typeof routineRef.name !== "string") {
    throw new Error(`triggers/${slug}/trigger.yaml has no spec.routineRef.name to fold into`);
  }
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const name = typeof metadata.slug === "string" ? metadata.slug : slug;
  return { slug, routineSlug: routineRef.name, spec: { name, ...spec } };
}

/**
 * Fold `triggers/<slug>/trigger.yaml` into the `spec.triggers` of the Routine each one names.
 *
 * A Trigger names exactly one Routine and cannot outlive it, so a separate top-level tree only
 * made orphans possible — a deleted Routine left its Triggers addressable, still resolving to a
 * Routine that no longer existed. The Trigger's `metadata.slug` becomes its `name` and stays its
 * public address, so webhook URLs already registered with third parties keep resolving.
 */
export async function embedTriggersInRoutines(soulPath: string): Promise<void> {
  const directory = join(soulPath, TRIGGERS_DIR);
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const byRoutine = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const slug = String(entry.name);
    if (!entry.isDirectory()) {
      throw new Error(`retired triggers directory contains unrecognized entry: ${slug}`);
    }
    const trigger = await readLegacyTrigger(directory, slug);
    const owned = byRoutine.get(trigger.routineSlug) ?? [];
    owned.push(trigger.spec);
    byRoutine.set(trigger.routineSlug, owned);
  }

  for (const [routineSlug, triggers] of byRoutine) {
    const path = join(soulPath, ROUTINES_DIR, routineSlug, "routine.yaml");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The Trigger was already an orphan before this migration ran. Dropping it is the whole
      // point: it could never have started a Run, and no Routine exists to fold it into.
      continue;
    }
    const routine = parseYaml(raw);
    if (!isRecord(routine) || !isRecord(routine.spec)) {
      throw new Error(`routines/${routineSlug}/routine.yaml is not a Routine document`);
    }
    const existing = Array.isArray(routine.spec.triggers) ? routine.spec.triggers : [];
    routine.spec = {
      ...routine.spec,
      triggers: [...existing, ...triggers].sort((a, b) =>
        String((a as Record<string, unknown>).name).localeCompare(
          String((b as Record<string, unknown>).name)
        )
      ),
    };
    await writeFile(path, stringifyYaml(routine), "utf8");
  }

  await rm(directory, { recursive: true });
}

export const EMBED_TRIGGERS_MIGRATION: SoulMigration = {
  version: 3,
  description: "fold standalone Trigger documents into their Routine's spec.triggers",
  up: embedTriggersInRoutines,
};
