/**
 * Catalog projection for `/resources`: joins the Soul's resource types with the runtime's totals
 * and derives everything else from the schemas themselves, so no per-type code is ever needed.
 *
 * The relationship graph is the reason this is a whole-catalog transform rather than a per-type
 * one: a type's inbound links can only be known by reading every other type's schema.
 */

import type { ResourceCatalogEntry, ResourceTypeSummary } from "./api";
import { deriveFields, type FieldDescriptor, parseSchema, type ResourceSchema } from "./schema";

const KEY_FIELD_LIMIT = 3;
const SYSTEM_NAMES = new Set(["id", "version", "createdAt", "updatedAt", "deletedAt"]);

export type IdStrategy = {
  readonly field: string;
  readonly prefix: string | null;
  readonly sequence: boolean;
};

export type CatalogType = {
  readonly name: string;
  readonly domain: string | null;
  readonly hasHooks: boolean;
  readonly fieldCount: number;
  readonly requiredCount: number;
  /** `null` means the API disclosed no total — the caller may not list this type. Never render 0. */
  readonly recordCount: number | null;
  readonly lastUpdatedAt: string | null;
  readonly idStrategy: IdStrategy | null;
  /** Types this one points at through `x-links`, and the types that point back. Both sorted. */
  readonly links: readonly string[];
  readonly linkedBy: readonly string[];
  /** A short preview of what a Record actually holds, for the catalog row. */
  readonly keyFields: readonly string[];
  readonly schemaError: string | null;
};

export type CatalogSortKey = "name" | "domain" | "records" | "fields" | "updated";
export type CatalogSort = { readonly key: CatalogSortKey; readonly dir: "asc" | "desc" };

function idStrategyOf(schema: ResourceSchema): IdStrategy {
  const declared = schema["x-id-strategy"];
  return {
    field: declared?.field ?? "id",
    prefix: declared?.prefix ?? null,
    sequence: declared?.sequence === true,
  };
}

function keyFieldsOf(fields: readonly FieldDescriptor[]): string[] {
  return fields
    .filter((f) => !f.isSystem && !f.isIdField && f.kind !== "object" && f.kind !== "array")
    .slice(0, KEY_FIELD_LIMIT)
    .map((f) => f.name);
}

function linkTargetsOf(fields: readonly FieldDescriptor[]): string[] {
  const targets = new Set<string>();
  for (const field of fields) {
    if (field.kind === "link" && field.linkTarget) targets.add(field.linkTarget);
  }
  return [...targets].sort();
}

/** One type's schema-derived facts, before the whole-catalog inbound-link pass. */
type Derived = {
  fields: FieldDescriptor[];
  idStrategy: IdStrategy | null;
  links: string[];
  keyFields: string[];
  schemaError: string | null;
};

function derive(summary: ResourceTypeSummary): Derived {
  const parsed = parseSchema(summary.schema);
  if (!parsed.ok) {
    return { fields: [], idStrategy: null, links: [], keyFields: [], schemaError: parsed.error };
  }
  const fields = deriveFields(parsed.schema);
  return {
    fields,
    idStrategy: idStrategyOf(parsed.schema),
    links: linkTargetsOf(fields),
    keyFields: keyFieldsOf(fields),
    schemaError: null,
  };
}

/**
 * Build the catalog rows. `totals` is joined by name; a type absent from it keeps a `null`
 * `recordCount`, which the UI must show as unknown rather than empty.
 */
export function buildCatalog(
  types: readonly ResourceTypeSummary[],
  totals: readonly ResourceCatalogEntry[]
): CatalogType[] {
  const totalByName = new Map(totals.map((t) => [t.name, t]));
  const derived = new Map(types.map((t) => [t.name, derive(t)]));

  const inbound = new Map<string, Set<string>>();
  for (const [name, d] of derived) {
    for (const target of d.links) {
      const set = inbound.get(target) ?? new Set<string>();
      set.add(name);
      inbound.set(target, set);
    }
  }

  return types.map((summary) => {
    const d = derived.get(summary.name) as Derived;
    const total = totalByName.get(summary.name);
    return {
      name: summary.name,
      domain: summary.domain ?? null,
      hasHooks: summary.hasHooks,
      fieldCount: d.fields.filter((f) => !f.isSystem).length,
      requiredCount: d.fields.filter((f) => f.required === true).length,
      recordCount: total?.count ?? null,
      lastUpdatedAt: total?.lastUpdatedAt ?? null,
      idStrategy: d.idStrategy,
      links: d.links,
      linkedBy: [...(inbound.get(summary.name) ?? [])].sort(),
      keyFields: d.keyFields,
      schemaError: d.schemaError,
    };
  });
}

/** Every domain present, sorted, for the domain filter. Undomained types are not represented. */
export function catalogDomains(rows: readonly CatalogType[]): string[] {
  return [...new Set(rows.flatMap((r) => (r.domain === null ? [] : [r.domain])))].sort();
}

/** Substring match over the facts a person would actually type: name, domain and field names. */
export function filterCatalog(
  rows: readonly CatalogType[],
  query: string,
  domain: string | null
): CatalogType[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (domain !== null && row.domain !== domain) return false;
    if (q === "") return true;
    return (
      row.name.toLowerCase().includes(q) ||
      (row.domain?.toLowerCase().includes(q) ?? false) ||
      row.keyFields.some((f) => f.toLowerCase().includes(q)) ||
      row.links.some((l) => l.toLowerCase().includes(q))
    );
  });
}

/** Whether this row has no value for the key at all — those trail in both directions. */
function isBlank(row: CatalogType, key: CatalogSortKey): boolean {
  switch (key) {
    case "records":
      return row.recordCount === null;
    case "updated":
      return row.lastUpdatedAt === null;
    case "domain":
      return row.domain === null;
    default:
      return false;
  }
}

/** Compares two rows that both have a value for `key`. */
function compare(a: CatalogType, b: CatalogType, key: CatalogSortKey): number {
  switch (key) {
    case "records":
      return (a.recordCount ?? 0) - (b.recordCount ?? 0);
    case "fields":
      return a.fieldCount - b.fieldCount;
    case "updated":
      return Date.parse(a.lastUpdatedAt ?? "") - Date.parse(b.lastUpdatedAt ?? "");
    case "domain":
      return (a.domain ?? "").localeCompare(b.domain ?? "");
    default:
      return a.name.localeCompare(b.name);
  }
}

/**
 * Stable sort into a new array. A row with no value for the key always trails, in both directions,
 * so an uncounted type never leads the list by looking like zero. Ties break by name.
 */
export function sortCatalog(rows: readonly CatalogType[], sort: CatalogSort): CatalogType[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const aBlank = isBlank(a, sort.key);
    const bBlank = isBlank(b, sort.key);
    if (aBlank !== bBlank) return aBlank ? 1 : -1;
    const primary = aBlank ? 0 : compare(a, b, sort.key) * sign;
    return primary === 0 ? a.name.localeCompare(b.name) : primary;
  });
}

export function isSystemFieldName(name: string): boolean {
  return SYSTEM_NAMES.has(name);
}
