import { expect, test } from "vitest";
import {
  cellText,
  compareValues,
  deriveFields,
  detailFields,
  type FieldDescriptor,
  filterRecords,
  formatIso,
  formFields,
  listColumns,
  parseSchema,
  renderValue,
  sortRecords,
} from "~/lib/schema";

// The mock `ticket` schema used throughout — exercises every x-* extension in a read view.
const TICKET_YAML = `
type: object
x-id-strategy: { prefix: "TICK-", sequence: true, field: id }
properties:
  id: { type: string }
  title: { type: string, x-immutable: true }
  customerId: { type: string, x-links: { target: customer } }
  priority: { type: string, enum: [low, high] }
  open: { type: boolean }
  tags: { type: array }
  meta: { type: object }
required: [title]
`;

function ticketSchema() {
  const result = parseSchema(TICKET_YAML);
  if (!result.ok) throw new Error(result.error);
  return result.schema;
}

test("parseSchema accepts valid YAML, rejects malformed and non-object without throwing", () => {
  expect(parseSchema(TICKET_YAML).ok).toBe(true);
  expect(parseSchema("just a string").ok).toBe(false); // non-object
  expect(parseSchema("foo: [unterminated").ok).toBe(false); // malformed
});

test("deriveFields preserves declared order and resolves kinds, ignoring write-side x-immutable", () => {
  const fields = deriveFields(ticketSchema());
  expect(fields.map((f) => f.name)).toEqual([
    "id",
    "title",
    "customerId",
    "priority",
    "open",
    "tags",
    "meta",
  ]);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  expect(byName.title.kind).toBe("string"); // x-immutable does not change kind
  expect(byName.customerId.kind).toBe("link");
  expect(byName.customerId.linkTarget).toBe("customer");
  expect(byName.priority.kind).toBe("enum");
  expect(byName.priority.enumValues).toEqual(["low", "high"]);
  expect(byName.open.kind).toBe("boolean");
  expect(byName.tags.kind).toBe("array");
  expect(byName.meta.kind).toBe("object");
  expect(byName.id.isIdField).toBe(true);
});

test("listColumns promotes id first, drops object/array, appends updatedAt", () => {
  const schema = ticketSchema();
  const cols = listColumns(deriveFields(schema), schema).map((c) => c.name);
  expect(cols[0]).toBe("id");
  expect(cols).not.toContain("tags"); // array excluded
  expect(cols).not.toContain("meta"); // object excluded
  expect(cols[cols.length - 1]).toBe("updatedAt"); // system recency column appended
});

test("listColumns synthesizes the id column when x-id-strategy.field is not a declared property", () => {
  const parsed = parseSchema(`
type: object
x-id-strategy: { field: ref }
properties:
  title: { type: string }
`);
  if (!parsed.ok) throw new Error(parsed.error);
  const cols = listColumns(deriveFields(parsed.schema), parsed.schema).map((c) => c.name);
  expect(cols[0]).toBe("ref");
});

test("listColumns caps schema columns at six (plus the trailing updatedAt)", () => {
  const props = Array.from({ length: 10 }, (_, i) => `  f${i}: { type: string }`).join("\n");
  const parsed = parseSchema(`type: object\nproperties:\n${props}`);
  if (!parsed.ok) throw new Error(parsed.error);
  const cols = listColumns(deriveFields(parsed.schema), parsed.schema);
  expect(cols.length).toBe(7); // 6 schema cols + updatedAt
  expect(cols[cols.length - 1].name).toBe("updatedAt");
});

test("listColumns shows updatedAt exactly once even when the schema declares it", () => {
  const parsed = parseSchema(`
type: object
properties:
  id: { type: string }
  updatedAt: { type: string, format: date-time }
`);
  if (!parsed.ok) throw new Error(parsed.error);
  const cols = listColumns(deriveFields(parsed.schema), parsed.schema).map((c) => c.name);
  expect(cols.filter((c) => c === "updatedAt").length).toBe(1);
  expect(cols[cols.length - 1]).toBe("updatedAt");
});

test("schema with no properties still yields an id column and updatedAt", () => {
  const parsed = parseSchema("type: object");
  if (!parsed.ok) throw new Error(parsed.error);
  const cols = listColumns(deriveFields(parsed.schema), parsed.schema).map((c) => c.name);
  expect(cols).toEqual(["id", "updatedAt"]);
});

test("detailFields lists all properties then the system block, de-duped", () => {
  const schema = ticketSchema();
  const names = detailFields(deriveFields(schema), schema).map((f) => f.name);
  // declared first
  expect(names.slice(0, 7)).toEqual([
    "id",
    "title",
    "customerId",
    "priority",
    "open",
    "tags",
    "meta",
  ]);
  // system block appended, but `id` is not duplicated (already declared)
  expect(names.filter((n) => n === "id").length).toBe(1);
  expect(names).toContain("version");
  expect(names).toContain("createdAt");
  expect(names).toContain("updatedAt");
});

test("renderValue maps every kind to a presentational primitive", () => {
  const fields = Object.fromEntries(deriveFields(ticketSchema()).map((f) => [f.name, f]));
  expect(renderValue(fields.title, null)).toEqual({ kind: "muted", text: "—" });
  expect(renderValue(fields.title, "")).toEqual({ kind: "muted", text: "—" });
  expect(renderValue(fields.title, "Login 500")).toEqual({ kind: "text", text: "Login 500" });
  expect(renderValue(fields.customerId, "CUST-88")).toEqual({
    kind: "link",
    to: "/resources/customer/CUST-88",
    label: "CUST-88",
  });
  expect(renderValue(fields.open, true)).toEqual({ kind: "bool", value: true });
  expect(renderValue(fields.tags, ["a", "b"])).toEqual({ kind: "text", text: "a, b" });
  expect(renderValue(fields.tags, [])).toEqual({ kind: "muted", text: "—" });
  expect(renderValue(fields.meta, { a: 1 })).toEqual({ kind: "json", text: '{"a":1}' });
});

test("deriveFields populates write-side flags (required, immutable, readOnly, format)", () => {
  const byName = Object.fromEntries(deriveFields(ticketSchema()).map((f) => [f.name, f]));
  expect(byName.title.immutable).toBe(true); // x-immutable: true
  expect(byName.title.required).toBe(true); // required: [title]
  expect(byName.open.immutable).toBe(false);
  expect(byName.open.required).toBe(false);
  expect(byName.customerId.readOnly).toBe(false);
});

test("formFields drops the system block, the sequence-generated id, and x-readOnly fields", () => {
  // TICKET_YAML uses x-id-strategy.sequence with field id → id is server-generated, not an input.
  const names = formFields(ticketSchema()).map((f) => f.name);
  expect(names).toEqual(["title", "customerId", "priority", "open", "tags", "meta"]);
  expect(names).not.toContain("id"); // auto-generated
});

test("formFields excludes the system id and any x-readOnly field", () => {
  const parsed = parseSchema(`
type: object
properties:
  id: { type: string }
  slug: { type: string, x-readOnly: true }
  name: { type: string }
`);
  if (!parsed.ok) throw new Error(parsed.error);
  const names = formFields(parsed.schema).map((f) => f.name);
  expect(names).toEqual(["name"]); // id is a system field, slug is x-readOnly
});

test("formFields keeps x-immutable fields (read-only handled by the form, not filtered out)", () => {
  const titleField = formFields(ticketSchema()).find((f) => f.name === "title");
  expect(titleField?.immutable).toBe(true);
});

test("formatIso renders a date and passes non-dates through unchanged", () => {
  expect(formatIso("2026-06-08T14:03:00Z")).toContain("2026");
  expect(formatIso("not-a-date")).toBe("not-a-date");
});

// ── Client sort / filter helpers (shell list interactivity; shared schema→UI mapping) ──────────────

// A schema exercising every comparable kind: string, number, date, boolean, enum, link.
const ROW_YAML = `
type: object
properties:
  id: { type: string }
  name: { type: string }
  count: { type: integer }
  due: { type: string, format: date }
  active: { type: boolean }
  priority: { type: string, enum: [low, high] }
  customerId: { type: string, x-links: { target: customer } }
`;
function rowFields(): Record<string, FieldDescriptor> {
  const parsed = parseSchema(ROW_YAML);
  if (!parsed.ok) throw new Error(parsed.error);
  return Object.fromEntries(deriveFields(parsed.schema).map((f) => [f.name, f]));
}
const ROWS = [
  { id: "a", name: "apple", count: 3, due: "2026-01-02", active: true, priority: "low" },
  { id: "b", name: "cherry", count: 10, due: "2026-03-01", active: false, priority: "high" },
  { id: "c", name: "banana", count: 1, due: "2026-02-01", active: true, priority: "low" },
];

test("cellText derives lowercased searchable text per kind", () => {
  const f = rowFields();
  expect(cellText(f.name, "Apple")).toBe("apple"); // lowercased
  expect(cellText(f.count, 3)).toBe("3");
  expect(cellText(f.active, true)).toBe("true");
  expect(cellText(f.active, false)).toBe("false");
  expect(cellText(f.priority, "high")).toBe("high");
  expect(cellText(f.customerId, "CUST-88")).toBe("cust-88");
  expect(cellText(f.due, "2026-01-02")).toContain("2026");
  expect(cellText(f.name, null)).toBe(""); // nullish → empty
  expect(cellText(f.name, "")).toBe("");
});

test("compareValues orders by kind: numeric, chronological, boolean, lexical", () => {
  const f = rowFields();
  expect(compareValues(f.count, 3, 10)).toBeLessThan(0); // numeric, not string "3" vs "10"
  expect(compareValues(f.due, "2026-01-02", "2026-03-01")).toBeLessThan(0); // chronological
  expect(compareValues(f.active, false, true)).toBeLessThan(0); // false < true
  expect(compareValues(f.name, "apple", "banana")).toBeLessThan(0); // lexical
  expect(compareValues(f.priority, "high", "low")).toBeLessThan(0); // enum → lexical
});

test("sortRecords asc/desc by kind, returning a new array (input untouched)", () => {
  const f = rowFields();
  const byCountAsc = sortRecords(ROWS, f.count, "asc").map((r) => r.id);
  expect(byCountAsc).toEqual(["c", "a", "b"]); // 1, 3, 10
  const byCountDesc = sortRecords(ROWS, f.count, "desc").map((r) => r.id);
  expect(byCountDesc).toEqual(["b", "a", "c"]);
  const byDueAsc = sortRecords(ROWS, f.due, "asc").map((r) => r.id);
  expect(byDueAsc).toEqual(["a", "c", "b"]); // Jan, Feb, Mar
  const byNameAsc = sortRecords(ROWS, f.name, "asc").map((r) => r.id);
  expect(byNameAsc).toEqual(["a", "c", "b"]); // apple, banana, cherry
  expect(ROWS.map((r) => r.id)).toEqual(["a", "b", "c"]); // original unmutated
});

test("sortRecords keeps nullish values last in BOTH directions and is stable", () => {
  const f = rowFields();
  const rows = [
    { id: "x", count: 5 },
    { id: "y", count: null },
    { id: "z", count: 2 },
    { id: "w", count: undefined },
  ];
  expect(sortRecords(rows, f.count, "asc").map((r) => r.id)).toEqual(["z", "x", "y", "w"]);
  // desc: non-null reversed, nullish still trailing; y before w preserved (stable)
  expect(sortRecords(rows, f.count, "desc").map((r) => r.id)).toEqual(["x", "z", "y", "w"]);
});

test("filterRecords does case-insensitive substring match across all columns", () => {
  const f = rowFields();
  const cols = [f.id, f.name, f.priority];
  expect(filterRecords(ROWS, cols, "apple").map((r) => r.id)).toEqual(["a"]);
  expect(filterRecords(ROWS, cols, "APPLE").map((r) => r.id)).toEqual(["a"]); // case-insensitive
  expect(filterRecords(ROWS, cols, "high").map((r) => r.id)).toEqual(["b"]); // matches priority col
  expect(filterRecords(ROWS, cols, "an").map((r) => r.id)).toEqual(["c"]); // "banana"
  expect(filterRecords(ROWS, cols, "zzz")).toEqual([]); // no match
});

test("filterRecords returns all records for a blank/whitespace query", () => {
  const f = rowFields();
  expect(filterRecords(ROWS, [f.name], "")).toHaveLength(3);
  expect(filterRecords(ROWS, [f.name], "   ")).toHaveLength(3);
});

// AC-V1-002 (read subset): a valid schema.yml yields a working list + detail with ZERO per-resource
// code — the same generic pipeline produces both projections for an arbitrary record.
test("AC-V1-002: schema alone drives a complete list + detail for a record", () => {
  const schema = ticketSchema();
  const record = {
    id: "TICK-1042",
    title: "Login 500 on Safari",
    customerId: "CUST-88",
    priority: "high",
    open: true,
    tags: ["safari"],
    meta: { sev: 1 },
    version: 4,
    createdAt: "2026-06-01T09:12:00Z",
    updatedAt: "2026-06-08T14:03:00Z",
  };
  const fields = deriveFields(schema);

  // list: every column renders a non-throwing cell from the record
  for (const col of listColumns(fields, schema)) {
    expect(renderValue(col, record[col.name as keyof typeof record])).toBeDefined();
  }
  // detail: id link, enum, bool, and system version all project correctly
  const detail = Object.fromEntries(detailFields(fields, schema).map((f) => [f.name, f]));
  expect(renderValue(detail.customerId, record.customerId)).toMatchObject({ kind: "link" });
  expect(renderValue(detail.open, record.open)).toMatchObject({ kind: "bool" });
  expect(renderValue(detail.version, record.version)).toEqual({ kind: "text", text: "4" });
});
