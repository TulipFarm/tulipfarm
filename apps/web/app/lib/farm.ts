import { BookOpen, Bot, Boxes, type LucideIcon, Plug, Puzzle, Workflow } from "lucide-react";
import { listAgents } from "./agents";
import { listResourceTypes } from "./api";
import { listIntegrations } from "./integrations";
import { listSpaces } from "./knowledge-api";
import { listRoutines } from "./routines";
import { listSkills } from "./skills";

/*
 * The Farm reads the Soul the way a field reads a season: one artifact, one tulip. Everything a
 * tulip encodes has to be a fact this module can point at — kind, name, and whether the thing can
 * actually run yet. Position and height are derived from a stable hash of the identity, never from
 * `Math.random`, so a farm keeps its shape between visits instead of being reshuffled each load.
 */

export type CropKind = "resource" | "agent" | "skill" | "routine" | "integration" | "space";

export type Crop = {
  kind: CropKind;
  /** Plural, for counts and the legend. */
  label: string;
  singular: string;
  /**
   * Categorical data token *name*, so the canvas can resolve it against the live theme and CSS can
   * wrap it in `var()`. Kind is data encoding, so this palette is the sanctioned one for it —
   * never `primary`, never a `status-*` tone.
   */
  colorVar: string;
  /** Where the legend row and a clicked tulip send the reader. */
  to: string;
  icon: LucideIcon;
  /**
   * A complete clause naming what a planted-but-inert artifact of this kind looks like, so callers
   * can list it verbatim. Absent when the kind has no such state.
   */
  dormantMeans?: string;
};

export const CROPS: readonly Crop[] = [
  {
    kind: "resource",
    label: "Resources",
    singular: "resource",
    colorVar: "--data-1",
    to: "/resources",
    icon: Boxes,
  },
  {
    kind: "agent",
    label: "Agents",
    singular: "agent",
    colorVar: "--data-2",
    to: "/agents",
    icon: Bot,
  },
  {
    kind: "skill",
    label: "Skills",
    singular: "skill",
    colorVar: "--data-3",
    to: "/skills",
    icon: Puzzle,
  },
  {
    kind: "routine",
    label: "Routines",
    singular: "routine",
    colorVar: "--data-4",
    to: "/routines",
    icon: Workflow,
    dormantMeans: "a routine with no trigger yet",
  },
  {
    kind: "integration",
    label: "Integrations",
    singular: "integration",
    colorVar: "--data-5",
    to: "/integrations",
    icon: Plug,
    dormantMeans: "an integration that is not connected",
  },
  {
    kind: "space",
    label: "Knowledge",
    singular: "space",
    colorVar: "--data-6",
    to: "/knowledge",
    icon: BookOpen,
  },
] as const;

const CROP_BY_KIND = new Map(CROPS.map((crop) => [crop.kind, crop]));

export function cropFor(kind: CropKind): Crop {
  const crop = CROP_BY_KIND.get(kind);
  if (!crop) throw new Error(`Unknown crop kind: ${kind}`);
  return crop;
}

export type Planting = {
  /** Stable across reloads; seeds this tulip's position, height and lean. */
  id: string;
  kind: CropKind;
  name: string;
  /** Second line of the hover label. Omitted rather than padded with a restatement of the name. */
  detail?: string;
  href: string;
  /**
   * A bloom says the artifact can act; a closed bud says it exists but nothing can start it.
   * Kinds with no such distinction are always in bloom rather than being given a fake one.
   */
  bloomed: boolean;
};

export type FarmState = {
  plantings: Planting[];
  counts: Record<CropKind, number>;
  total: number;
  /** Crops whose list call failed. The rest of the field still renders. */
  failed: CropKind[];
};

/* FNV-1a. Small, stable, and dependency-free — the field must look the same on every visit. */
export function plantingSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

export type Season = {
  name: string;
  /** Distinct crop kinds this farm has planted. */
  crops: number;
  /** Every crop kind that exists. A real denominator, not an invented target. */
  ofCrops: number;
  /** The kinds nothing is planted in yet. */
  missing: CropKind[];
};

/**
 * Names a farm by how much of the catalog it actually grows. The denominator is the number of crop
 * kinds that exist, so "4 of 6" is a fact rather than a made-up quota.
 */
export function farmSeason(counts: Record<CropKind, number>): Season {
  const missing = CROPS.filter((crop) => (counts[crop.kind] ?? 0) === 0).map((crop) => crop.kind);
  const crops = CROPS.length - missing.length;
  const name =
    crops === 0
      ? "Bare soil"
      : crops === 1
        ? "First bed"
        : crops < CROPS.length - 1
          ? "Mixed beds"
          : crops < CROPS.length
            ? "Broad farm"
            : "Full tulip farm";
  return { name, crops, ofCrops: CROPS.length, missing };
}

const EMPTY_COUNTS: Record<CropKind, number> = {
  resource: 0,
  agent: 0,
  skill: 0,
  routine: 0,
  integration: 0,
  space: 0,
};

export function countsFor(plantings: readonly Planting[]): Record<CropKind, number> {
  const counts = { ...EMPTY_COUNTS };
  for (const planting of plantings) counts[planting.kind] += 1;
  return counts;
}

/*
 * One harvester per crop. Each returns the plantings for its kind so a single failing endpoint
 * costs one crop rather than the whole field.
 */
const HARVESTERS: ReadonlyArray<{ kind: CropKind; harvest: () => Promise<Planting[]> }> = [
  {
    kind: "resource",
    harvest: async () =>
      (await listResourceTypes()).map((type) => ({
        id: `resource:${type.name}`,
        kind: "resource" as const,
        name: type.name,
        detail: type.hasHooks ? "has hooks" : undefined,
        href: `/resources/${encodeURIComponent(type.name)}`,
        bloomed: true,
      })),
  },
  {
    kind: "agent",
    harvest: async () =>
      (await listAgents()).map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        name: agent.label?.trim() || agent.name,
        detail: agent.domain ?? agent.autonomy,
        href: `/agents/${encodeURIComponent(agent.name)}`,
        bloomed: true,
      })),
  },
  {
    kind: "skill",
    harvest: async () =>
      (await listSkills())
        // Built-in skills ship with every instance. The farm is what this business built, so a
        // skill only earns a tulip once someone installed or authored it here.
        .filter((skill) => skill.provenance !== "bundled")
        .map((skill) => ({
          id: `skill:${skill.name}`,
          kind: "skill" as const,
          name: skill.name,
          detail: skill.provenance,
          href: `/skills/${encodeURIComponent(skill.name)}`,
          bloomed: true,
        })),
  },
  {
    kind: "routine",
    harvest: async () =>
      (await listRoutines()).map((routine) => ({
        id: `routine:${routine.slug}`,
        kind: "routine" as const,
        name: routine.displayName?.trim() || routine.slug,
        detail:
          routine.triggers.length > 0
            ? `${routine.triggers.length} ${routine.triggers.length === 1 ? "trigger" : "triggers"}`
            : "no trigger",
        href: `/routines/${encodeURIComponent(routine.slug)}`,
        bloomed: routine.triggers.length > 0,
      })),
  },
  {
    kind: "integration",
    harvest: async () =>
      (await listIntegrations())
        // `installed` only means the manifest ships with this deployment — the whole catalog is
        // installed on a brand-new instance. Connecting one is the act the business actually took.
        .filter((integration) => integration.status === "connected")
        .map((integration) => ({
          id: `integration:${integration.name}`,
          kind: "integration" as const,
          name: integration.title?.trim() || integration.name,
          detail: integration.category ?? undefined,
          href: `/integrations/${encodeURIComponent(integration.name)}`,
          bloomed: true,
        })),
  },
  {
    kind: "space",
    harvest: async () =>
      (await listSpaces()).items.map((space) => ({
        id: `space:${space.id}`,
        kind: "space" as const,
        name: space.name,
        detail: space.description ?? undefined,
        href: `/knowledge/spaces/${encodeURIComponent(space.id)}`,
        bloomed: true,
      })),
  },
];

/**
 * Loads every crop in parallel. A crop that fails is reported in `failed` and the field still
 * renders; only a total blackout throws, because that is the API being down rather than one
 * endpoint being unhappy.
 *
 * @throws the first rejection when every crop failed.
 */
export async function fetchFarm(): Promise<FarmState> {
  const settled = await Promise.allSettled(HARVESTERS.map(({ harvest }) => harvest()));

  const plantings: Planting[] = [];
  const failed: CropKind[] = [];
  let firstError: unknown;

  settled.forEach((result, index) => {
    const kind = HARVESTERS[index]?.kind;
    if (!kind) return;
    if (result.status === "fulfilled") {
      plantings.push(...result.value);
    } else {
      failed.push(kind);
      firstError ??= result.reason;
    }
  });

  if (failed.length === HARVESTERS.length) {
    throw firstError instanceof Error ? firstError : new Error("The farm could not be read.");
  }

  /*
   * Scatter by seed rather than by arrival order, so crops interleave the way a real field does
   * instead of banding into six stripes. Ties break on id to keep the sort total.
   */
  plantings.sort((a, b) => plantingSeed(a.id) - plantingSeed(b.id) || a.id.localeCompare(b.id));

  return { plantings, counts: countsFor(plantings), total: plantings.length, failed };
}

const CACHE_TTL_MS = 15_000;
let cache: { at: number; value: Promise<FarmState> } | null = null;

/**
 * Shared, briefly cached read. The route and the sidebar almanac both want the same six calls on
 * the same navigation; without this they would each fire their own round.
 */
export function loadFarm(options?: { force?: boolean }): Promise<FarmState> {
  const now = Date.now();
  if (!options?.force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const value = fetchFarm();
  cache = { at: now, value };
  // A rejection must not be cached, or one blip pins the failure for the rest of the TTL.
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}
