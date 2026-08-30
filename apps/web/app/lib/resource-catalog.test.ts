import { describe, expect, it } from "vitest";
import type { ResourceCatalogEntry, ResourceTypeSummary } from "./api";
import { buildCatalog, catalogDomains, filterCatalog, sortCatalog } from "./resource-catalog";

function type(
  name: string,
  schema: string,
  extra: Partial<ResourceTypeSummary> = {}
): ResourceTypeSummary {
  return { name, schema, hasHooks: false, ...extra };
}

const CUSTOMER = `
type: object
required: [name]
properties:
  name: { type: string }
  tier: { type: string, enum: [free, pro] }
  notes: { type: object }
`;

const TICKET = `
type: object
required: [title, customer]
x-id-strategy: { prefix: TCK, sequence: true, field: ref }
properties:
  ref: { type: string }
  title: { type: string }
  customer: { type: string, x-links: { target: customer } }
  owner: { type: string, x-links: { target: customer } }
`;

const TYPES = [
  type("customer", CUSTOMER, { domain: "sales" }),
  type("ticket", TICKET, { domain: "support", hasHooks: true }),
];

const TOTALS: ResourceCatalogEntry[] = [
  { name: "customer", count: 12, lastUpdatedAt: "2026-05-01T00:00:00.000Z" },
  { name: "ticket", count: 3, lastUpdatedAt: "2026-06-01T00:00:00.000Z" },
];

describe("buildCatalog", () => {
  it("counts only declared fields and the required ones among them", () => {
    const [customer] = buildCatalog([TYPES[0]], []);
    expect(customer.fieldCount).toBe(3);
    expect(customer.requiredCount).toBe(1);
  });

  it("derives outbound links and dedupes two fields pointing at one target", () => {
    const ticket = buildCatalog(TYPES, TOTALS).find((r) => r.name === "ticket");
    expect(ticket?.links).toEqual(["customer"]);
  });

  it("derives inbound links by reading every other schema", () => {
    const customer = buildCatalog(TYPES, TOTALS).find((r) => r.name === "customer");
    expect(customer?.linkedBy).toEqual(["ticket"]);
    expect(customer?.links).toEqual([]);
  });

  it("reads the id strategy so the catalog can show generated ids", () => {
    const rows = buildCatalog(TYPES, TOTALS);
    expect(rows.find((r) => r.name === "ticket")?.idStrategy).toEqual({
      field: "ref",
      prefix: "TCK",
      sequence: true,
    });
    expect(rows.find((r) => r.name === "customer")?.idStrategy).toEqual({
      field: "id",
      prefix: null,
      sequence: false,
    });
  });

  it("previews key fields, skipping the id field and object-valued ones", () => {
    const rows = buildCatalog(TYPES, TOTALS);
    expect(rows.find((r) => r.name === "customer")?.keyFields).toEqual(["name", "tier"]);
    expect(rows.find((r) => r.name === "ticket")?.keyFields).toEqual([
      "title",
      "customer",
      "owner",
    ]);
  });

  it("leaves recordCount null when the API disclosed no total for that type", () => {
    const rows = buildCatalog(TYPES, [TOTALS[0]]);
    expect(rows.find((r) => r.name === "customer")?.recordCount).toBe(12);
    expect(rows.find((r) => r.name === "ticket")?.recordCount).toBeNull();
    expect(rows.find((r) => r.name === "ticket")?.lastUpdatedAt).toBeNull();
  });

  it("keeps a type whose schema will not parse, and reports the reason", () => {
    const rows = buildCatalog([type("broken", "just a string")], []);
    expect(rows[0].schemaError).toBe("schema is not an object");
    expect(rows[0].fieldCount).toBe(0);
    expect(rows[0].links).toEqual([]);
  });
});

describe("catalogDomains", () => {
  it("lists each domain once, sorted, and omits undomained types", () => {
    const rows = buildCatalog([...TYPES, type("note", CUSTOMER)], []);
    expect(catalogDomains(rows)).toEqual(["sales", "support"]);
  });
});

describe("filterCatalog", () => {
  const rows = buildCatalog(TYPES, TOTALS);

  it("matches on a field name, not just the type name", () => {
    expect(filterCatalog(rows, "tier", null).map((r) => r.name)).toEqual(["customer"]);
  });

  it("matches on a link target", () => {
    expect(filterCatalog(rows, "customer", null).map((r) => r.name)).toEqual([
      "customer",
      "ticket",
    ]);
  });

  it("intersects the query with the domain filter", () => {
    expect(filterCatalog(rows, "customer", "support").map((r) => r.name)).toEqual(["ticket"]);
    expect(filterCatalog(rows, "", "sales").map((r) => r.name)).toEqual(["customer"]);
  });
});

describe("sortCatalog", () => {
  const rows = buildCatalog(TYPES, TOTALS);

  it("sorts by record count", () => {
    expect(sortCatalog(rows, { key: "records", dir: "desc" }).map((r) => r.name)).toEqual([
      "customer",
      "ticket",
    ]);
  });

  it("trails an undisclosed count in both directions rather than reading it as zero", () => {
    const partial = buildCatalog([...TYPES, type("hidden", CUSTOMER)], TOTALS);
    expect(sortCatalog(partial, { key: "records", dir: "asc" }).at(-1)?.name).toBe("hidden");
    expect(sortCatalog(partial, { key: "records", dir: "desc" }).at(-1)?.name).toBe("hidden");
  });

  it("trails an undomained type when sorting by domain, in both directions", () => {
    const partial = buildCatalog([...TYPES, type("note", CUSTOMER)], TOTALS);
    expect(sortCatalog(partial, { key: "domain", dir: "asc" }).at(-1)?.name).toBe("note");
    expect(sortCatalog(partial, { key: "domain", dir: "desc" }).at(-1)?.name).toBe("note");
  });

  it("breaks ties by name so the order never wobbles between renders", () => {
    const tied = buildCatalog([type("b", CUSTOMER), type("a", CUSTOMER)], []);
    expect(sortCatalog(tied, { key: "fields", dir: "desc" }).map((r) => r.name)).toEqual([
      "a",
      "b",
    ]);
  });
});
