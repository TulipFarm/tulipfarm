import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";
import { bundledIntegrationsDir } from "./bundled";

/*
 * The curated integration catalog (`integrations/registry.yml`).
 *
 * Discovery stays authoritative for what is installable: a registry entry only decorates a bundled
 * integration with presentation metadata, or points at a third-party repo to clone. An entry that
 * matches neither is inert — it is never enough on its own to make something appear installable.
 */

export interface RegistryEntry {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  homepage?: string;
  /**
   * Simple Icons slug for the brand mark. Duplicated from the manifest so a curated entry that is
   * not installed yet still shows its logo — nothing has been cloned, so there is no manifest to
   * read it from.
   */
  icon?: string;
  /**
   * The brand's hex, for a brand the icon set does not carry. Slack and Microsoft Teams asked to
   * be removed from Simple Icons, so their rows resolve no mark and no colour with it — and one
   * grey row in an otherwise branded catalog reads as a failed image, not as a brand without a
   * logo. Naming the colour here lets the monogram carry the brand instead. Ignored when `icon`
   * resolves, so a mark and its colour can never disagree.
   */
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

/**
 * Reads the curated catalog. A missing or malformed registry is not fatal — the marketplace simply
 * falls back to bare discovery, which is strictly better than failing the page.
 */
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
