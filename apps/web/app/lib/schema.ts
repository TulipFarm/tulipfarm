/* Schema transforms already ran server-side; this module only derives presentation fields. */

import { parse as parseYaml } from "yaml";

// Names the API attaches to every record on top of the schema's own properties.
const SYSTEM_FIELDS = ["id", "version", "createdAt", "updatedAt", "deletedAt"] as const;
const SYSTEM_DATE_NAMES = new Set(["createdAt", "updatedAt", "deletedAt"]);
const MAX_LIST_COLUMNS = 6;

export type JsonSchemaProperty = {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  format?: string;
  enum?: unknown[];
  "x-links"?: { target: string };
  // Write-side flags: surfaced on the descriptor so create/edit forms can honor them. The read
  // projections (list/detail) ignore them; only `formFields` + the form components consume them.
  "x-immutable"?: boolean;
  "x-readOnly"?: boolean;
};

export type ResourceSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  "x-id-strategy"?: { prefix?: string; sequence?: boolean; field?: string };
};

export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "enum"
  | "link"
  | "date"
  | "unknown";

export type FieldDescriptor = {
  name: string;
  kind: FieldKind;
  linkTarget?: string;
  enumValues?: string[];
  isSystem: boolean;
  isIdField: boolean;
  required?: boolean;
  immutable?: boolean;
  readOnly?: boolean;
  format?: string;
};

export type ParseResult = { ok: true; schema: ResourceSchema } | { ok: false; error: string };

export type RenderedCell =
  | { kind: "muted"; text: string }
  | { kind: "text"; text: string }
  | { kind: "link"; to: string; label: string }
  | { kind: "bool"; value: boolean }
  | { kind: "json"; text: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Wraps yaml.parse so a malformed or non-object schema never throws — callers render a contained
// error instead of crashing the route.
export function parseSchema(yamlString: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlString);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "invalid YAML" };
  }
  if (!isObject(parsed)) return { ok: false, error: "schema is not an object" };
  return { ok: true, schema: parsed as ResourceSchema };
}

function idFieldName(schema: ResourceSchema): string {
  return schema["x-id-strategy"]?.field ?? "id";
}

function resolveKind(name: string, prop: JsonSchemaProperty): FieldKind {
  if (prop["x-links"]) return "link";
  if (prop.enum) return "enum";
  if (prop.format === "date" || prop.format === "date-time" || SYSTEM_DATE_NAMES.has(name)) {
    return "date";
  }
  switch (prop.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function describe(
  name: string,
  prop: JsonSchemaProperty,
  idField: string,
  required: ReadonlySet<string>
): FieldDescriptor {
  const kind = resolveKind(name, prop);
  return {
    name,
    kind,
    linkTarget: kind === "link" ? prop["x-links"]?.target : undefined,
    enumValues: kind === "enum" ? (prop.enum ?? []).map(String) : undefined,
    isSystem: (SYSTEM_FIELDS as readonly string[]).includes(name),
    isIdField: name === idField,
    required: required.has(name),
    immutable: prop["x-immutable"] === true,
    readOnly: prop["x-readOnly"] === true,
    format: prop.format,
  };
}

// Ordered descriptors for every declared property (declared order preserved).
export function deriveFields(schema: ResourceSchema): FieldDescriptor[] {
  const idField = idFieldName(schema);
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return Object.keys(props).map((name) => describe(name, props[name], idField, required));
}

// Editable inputs for create/edit forms: declared properties minus the system block and minus any
// `x-readOnly` field, and minus the id field when it's server-generated (x-id-strategy.sequence).
// This is the write-side mirror of listColumns/detailFields — the zero-per-resource-code
// pipeline for forms. `x-immutable` fields are kept (read-only on edit, editable on create).
export function formFields(schema: ResourceSchema): FieldDescriptor[] {
  const autoId = schema["x-id-strategy"]?.sequence === true ? idFieldName(schema) : null;
  return deriveFields(schema).filter((f) => !f.isSystem && !f.readOnly && f.name !== autoId);
}

function syntheticDescriptor(name: string, kind: FieldKind, idField: string): FieldDescriptor {
  return {
    name,
    kind,
    isSystem: (SYSTEM_FIELDS as readonly string[]).includes(name),
    isIdField: name === idField,
  };
}

// List columns: id promoted to front (synthesized if the id field isn't a declared property),
// object/array dropped (shown in detail only), capped, with a trailing synthesized "updatedAt".
export function listColumns(fields: FieldDescriptor[], schema?: ResourceSchema): FieldDescriptor[] {
  const idField = schema ? idFieldName(schema) : (fields.find((f) => f.isIdField)?.name ?? "id");

  const renderable = fields.filter((f) => f.kind !== "object" && f.kind !== "array");
  const idCol =
    renderable.find((f) => f.name === idField) ?? syntheticDescriptor(idField, "string", idField);
  // updatedAt is appended as the trailing system column, so drop any declared copy to avoid a dupe.
  const rest = renderable.filter((f) => f.name !== idField && f.name !== "updatedAt");

  const columns = [idCol, ...rest].slice(0, MAX_LIST_COLUMNS);
  columns.push(syntheticDescriptor("updatedAt", "date", idField));
  return columns;
}

// Every column a list view could show: id first, then each renderable declared field in schema
// order, then the system timestamps. `listColumns` is the capped default view over this set, so the
// column picker offers fields the default view had to drop.
export function availableColumns(
  fields: FieldDescriptor[],
  schema?: ResourceSchema
): FieldDescriptor[] {
  const idField = schema ? idFieldName(schema) : (fields.find((f) => f.isIdField)?.name ?? "id");
  const renderable = fields.filter((f) => f.kind !== "object" && f.kind !== "array");
  const idCol =
    renderable.find((f) => f.name === idField) ?? syntheticDescriptor(idField, "string", idField);
  const declared = new Set(renderable.map((f) => f.name));
  const system = (["createdAt", "updatedAt"] as const)
    .filter((name) => !declared.has(name))
    .map((name) => syntheticDescriptor(name, "date", idField));
  return [idCol, ...renderable.filter((f) => f.name !== idField), ...system];
}

// Detail fields: every schema property, then the system block, de-duped against declared properties.
export function detailFields(
  fields: FieldDescriptor[],
  schema?: ResourceSchema
): FieldDescriptor[] {
  const idField = schema ? idFieldName(schema) : (fields.find((f) => f.isIdField)?.name ?? "id");
  const declared = new Set(fields.map((f) => f.name));
  const system = SYSTEM_FIELDS.filter((name) => !declared.has(name)).map((name) =>
    syntheticDescriptor(name, SYSTEM_DATE_NAMES.has(name) ? "date" : "string", idField)
  );
  return [...fields, ...system];
}

// Locale-formatted date; isolated so it can be unit-tested on a fixed input.
export function formatIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const countFormat = new Intl.NumberFormat();

/**
 * Renders a count for display. `null` means the count is withheld rather than zero, so it becomes
 * an em dash: rendering it as `0` would invent a fact and read as "this is empty".
 */
export function formatCount(value: number | null): string {
  return value === null ? "\u2014" : countFormat.format(value);
}

/**
 * Coarse relative label ("just now" / "5m ago" / "2d ago"). Empty for unparseable input.
 * Pair it with an absolute `title`, since a relative label alone hides the actual instant.
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Locale-formatted calendar day for a `format: date` field — no time of day.
 *
 * A bare `YYYY-MM-DD` must be built from its parts rather than handed to `new Date`, which reads
 * it as UTC midnight and so renders the previous day everywhere west of Greenwich.
 */
export function formatIsoDate(value: string): string {
  const parts = DATE_ONLY.exec(value.trim());
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

// Single entry point for the "date" kind, so the read view and the filter cannot drift apart.
function formatDateField(field: FieldDescriptor, value: string): string {
  return field.format === "date" ? formatIsoDate(value) : formatIso(value);
}

// Best human label for a target record: a hinted field, else the first non-system string, else id.
// Shared by the x-links combobox (picker) and the detail link (so both show "Acme Corp", not a UUID).
const LABEL_HINTS = ["name", "title", "label", "summary"];
const LABEL_SYSTEM = new Set(["id", "version", "createdAt", "updatedAt", "deletedAt"]);
export function recordLabel(record: Record<string, unknown>): string {
  for (const hint of LABEL_HINTS) {
    const v = record[hint];
    if (typeof v === "string" && v) return v;
  }
  for (const [k, v] of Object.entries(record)) {
    if (!LABEL_SYSTEM.has(k) && typeof v === "string" && v) return v;
  }
  return String(record.id ?? "");
}

// Raw value → presentational primitive. The single source of truth for how each kind renders.
// `linkLabels` (value→display name) resolves an x-links id to the target record's label when known.
export function renderValue(
  field: FieldDescriptor,
  value: unknown,
  linkLabels?: Record<string, string>
): RenderedCell {
  if (value === null || value === undefined || value === "") return { kind: "muted", text: "-" };

  switch (field.kind) {
    case "link": {
      const raw = String(value);
      if (!field.linkTarget) return { kind: "text", text: raw };
      return {
        kind: "link",
        to: `/resources/${encodeURIComponent(field.linkTarget)}/${encodeURIComponent(raw)}`,
        label: linkLabels?.[raw] ?? raw,
      };
    }
    case "boolean":
      return { kind: "bool", value: Boolean(value) };
    case "date":
      return { kind: "text", text: formatDateField(field, String(value)) };
    case "array": {
      const arr = Array.isArray(value) ? value : [value];
      if (arr.length === 0) return { kind: "muted", text: "-" };
      return { kind: "text", text: arr.map(String).join(", ") };
    }
    case "object":
      return { kind: "json", text: JSON.stringify(value) };
    default:
      return { kind: "text", text: String(value) };
  }
}

// ── Client sort / filter (shell list interactivity) ───────────────────────────────────────────────
// Pure and schema-aware, mirroring renderValue's kind switch. The shell list page composes these over
// the in-memory record set; tf-data-table renders the same schema-shaped columns presentationally.

export type SortState = { field: string; dir: "asc" | "desc" };

// Treats null/undefined/"" as absent — the same "empty" renderValue shows as an em dash.
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

// Lowercased text used for substring filtering. Mirrors renderValue's per-kind formatting so the
// filter matches what the user sees (date → formatted, link → label, bool → true/false).
export function cellText(field: FieldDescriptor, value: unknown): string {
  if (isBlank(value)) return "";
  switch (field.kind) {
    case "boolean":
      return value ? "true" : "false";
    case "date":
      return formatDateField(field, String(value)).toLowerCase();
    case "array": {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map(String).join(", ").toLowerCase();
    }
    case "object":
      return JSON.stringify(value).toLowerCase();
    default:
      return String(value).toLowerCase();
  }
}

// Keep a record when any column's text contains the query. Blank query → unchanged input.
export function filterRecords<T extends Record<string, unknown>>(
  records: T[],
  columns: FieldDescriptor[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return records;
  return records.filter((record) =>
    columns.some((col) => cellText(col, record[col.name]).includes(q))
  );
}

// Compares two NON-blank values by kind (blanks are handled by sortRecords so they sort last in both
// directions). Numeric and chronological kinds compare by value, not string; everything else lexically.
export function compareValues(field: FieldDescriptor, a: unknown, b: unknown): number {
  switch (field.kind) {
    case "number":
      return Number(a) - Number(b);
    case "date":
      return new Date(String(a)).getTime() - new Date(String(b)).getTime();
    case "boolean":
      return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    default:
      return String(a).localeCompare(String(b));
  }
}

// Stable sort into a new array. Blank values always trail, regardless of direction.
export function sortRecords<T extends Record<string, unknown>>(
  records: T[],
  field: FieldDescriptor,
  dir: "asc" | "desc"
): T[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...records].sort((ra, rb) => {
    const a = ra[field.name];
    const b = rb[field.name];
    const aBlank = isBlank(a);
    const bBlank = isBlank(b);
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    return sign * compareValues(field, a, b);
  });
}
