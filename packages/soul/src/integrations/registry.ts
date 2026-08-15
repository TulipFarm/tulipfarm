import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../types";
import { bundledIntegrationsDir } from "./bundled";

/* Curated registry only decorates bundled integrations or points at third-party repos. */

export interface RegistryEntry {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  homepage?: string;
  /** Duplicated icon slug lets uninstalled curated entries show their logo. */
  icon?: string;
  /** Fallback brand hex for brands absent from Simple Icons; ignored when an icon resolves. */
  color?: string;
  /** Git source for a curated third-party integration; absent means it ships in the image. */
  source?: string;
}

/** `RRGGBB`, with or without the `#` an author is likely to paste. */
const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

function asHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return HEX_RE.exec(value.trim())?.[1]?.toUpperCase();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Missing or malformed registry is non-fatal; marketplace falls back to discovery. */
export async function loadIntegrationRegistry(
  logger: Logger,
  root = bundledIntegrationsDir()
): Promise<Map<string, RegistryEntry>> {
  const entries = new Map<string, RegistryEntry>();
  let raw: string;
  try {
    raw = await readFile(join(root, "registry.yml"), "utf8");
  } catch {
    return entries;
  }

  try {
    const parsed = (parseYaml(raw) ?? {}) as { integrations?: unknown };
    const list = Array.isArray(parsed.integrations) ? parsed.integrations : [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const name = asString(record.name);
      if (!name || entries.has(name)) continue;
      entries.set(name, {
        name,
        title: asString(record.title),
        description: asString(record.description),
        category: asString(record.category),
        homepage: asString(record.homepage),
        icon: asString(record.icon),
        color: asHex(record.color),
        source: asString(record.source),
      });
    }
  } catch (error) {
    logger.error(
      `Integration registry: cannot parse "${join(root, "registry.yml")}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return entries;
}
